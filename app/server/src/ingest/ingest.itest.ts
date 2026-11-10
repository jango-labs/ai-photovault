import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { JobWorker } from '../jobs/worker.js';
import { NotApprovedError, approvalPath, type Policy } from './approval.js';
import { deriveHandler, markDerivativeFailed } from './derive-job.js';
import { sha256File } from './extract.js';
import { ImportsService } from './imports.js';
import { IngestService, type Counters } from './service.js';
import { makeJpeg, type FakeJpeg } from './testkit.js';

let h: Handles | null; let uid: string; let src: string; let deriv: string;
const dirs: string[] = [];
const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-itest-'))); dirs.push(d); return d; };
const policy = (): Policy => ({ approved: [{ path: src, modes: ['DRY_RUN', 'APPLY'], approvedAt: 'test' }] });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const ing = (o: Partial<ConstructorParameters<typeof IngestService>[0]> = {}) => new IngestService({ sql: h!.app, policy: policy(), derivativesDir: deriv, heartbeatMs: 10, ...o });
const put = (rel: string, o: FakeJpeg = {}) => makeJpeg(path.join(src, rel), { width: 320, height: 214, ...o });
const worker = (conc = 2) => new JobWorker(h!.svc, { 'derive.preview': deriveHandler(h!.svc, deriv) }, { onDead: markDerivativeFailed(h!.svc), concurrency: conc, backoffBaseSeconds: 0 });
const q = async <T extends object = Record<string, never>>(text: string): Promise<T[]> => (await h!.svc.unsafe(text)) as unknown as T[];
const n = async (table: string, where = 'true') => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);
const files = (rel = '') => fs.readdirSync(path.join(src, rel)).sort();

beforeAll(async () => { h = await tryHandles(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
beforeEach(async () => {
  if (!h) return;
  await wipe(h.svc); uid = await makeUser(h.svc, 'owner@example.test');           // a fresh account per test (deleting a user cascades through everything, append-only tables included)
  src = mk(); deriv = mk();
});

describe('approval gate', () => {
  it('refuses an unapproved directory — dry run included — before reading or recording anything', async (ctx) => {
    need(ctx); await put('2024/Kenya/a.jpg');
    const unapproved = new IngestService({ sql: h!.app, policy: { approved: [] }, derivativesDir: deriv });
    await expect(unapproved.run(uid, src, 'DRY_RUN')).rejects.toBeInstanceOf(NotApprovedError);
    await expect(unapproved.run(uid, src, 'APPLY')).rejects.toBeInstanceOf(NotApprovedError);
    expect(await n('import_runs')).toBe(0); expect(await n('library_roots')).toBe(0); expect(await n('photos')).toBe(0);
  });
  it('a dry-run approval does not allow an import', async (ctx) => {
    need(ctx);
    const dryOnly = new IngestService({ sql: h!.app, policy: { approved: [{ path: src, modes: ['DRY_RUN'], approvedAt: 't' }] }, derivativesDir: deriv });
    await expect(dryOnly.run(uid, src, 'APPLY')).rejects.toBeInstanceOf(NotApprovedError);
    expect((await dryOnly.run(uid, src, 'DRY_RUN')).state).toBe('COMPLETED');
  });
  it('refuses a directory with RAW files or a Lightroom catalogue, and previews placed inside the source', async (ctx) => {
    need(ctx); await put('a.jpg'); fs.writeFileSync(path.join(src, 'shot.NEF'), 'x');
    await expect(ing().run(uid, src, 'DRY_RUN')).rejects.toThrow(/RAW/);
    fs.rmSync(path.join(src, 'shot.NEF')); fs.writeFileSync(path.join(src, 'x.lrcat'), 'x');
    await expect(ing().run(uid, src, 'DRY_RUN')).rejects.toThrow(/catalog/i);
    fs.rmSync(path.join(src, 'x.lrcat'));
    await expect(ing({ derivativesDir: path.join(src, 'previews') }).run(uid, src, 'DRY_RUN')).rejects.toThrow(/separate/);
    expect(await n('import_runs')).toBe(0);
  });
});

describe('dry run', () => {
  it('reports what would happen and changes no photograph data, jobs or files', async (ctx) => {
    need(ctx);
    await put('2024/Kenya/a.jpg', { pattern: 1 }); await put('2024/Kenya/b.jpg', { pattern: 2 }); await put('2023/Norway/c.jpg', { pattern: 3 });
    fs.writeFileSync(path.join(src, '2024/notes.txt'), 'x');
    const before = files('2024/Kenya');
    const r = await ing().run(uid, src, 'DRY_RUN');
    expect(r.state).toBe('COMPLETED'); expect(r.counters).toMatchObject({ scanned: 3, new: 3, unchanged: 0, errors: 0, complete: true }); expect(r.counters.skipped.not_jpeg).toBe(1);
    expect(await n('photos')).toBe(0); expect(await n('photo_versions')).toBe(0); expect(await n('jobs')).toBe(0); expect(await n('sync_events')).toBe(0);
    expect(files('2024/Kenya')).toEqual(before); expect(fs.readdirSync(deriv)).toEqual([]);
    const items = await q<{ action: string; relpath: string }>(`SELECT action, relpath FROM import_items WHERE run_id = '${r.runId}' ORDER BY relpath`);
    expect(items.map((i) => `${i.action} ${i.relpath}`)).toEqual(['NEW 2023/Norway/c.jpg', 'NEW 2024/Kenya/a.jpg', 'NEW 2024/Kenya/b.jpg']);
    expect((await q<{ mode: string; state: string }>(`SELECT mode, state FROM import_runs`))[0]).toMatchObject({ mode: 'DRY_RUN', state: 'COMPLETED' });
  });
  it('recognises two identical copies inside the same scan', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 4 }); fs.copyFileSync(path.join(src, 'a.jpg'), path.join(src, 'a copy.jpg'));
    const r = await ing().run(uid, src, 'DRY_RUN');
    expect(r.counters).toMatchObject({ new: 1, duplicateFiles: 1 });
  });
});

describe('import (apply)', () => {
  it('registers photographs with provenance, queues previews, and leaves the originals exactly as they were', async (ctx) => {
    need(ctx);
    await put('2024/Kenya/lion.jpg', { pattern: 1, make: 'Canon', model: 'Canon EOS R5', lens: 'RF100-500mm', focal: 500, fnumber: 7.1, exposure: '1/2000', iso: 800, captureAt: '2024:03:12 06:30:00', gps: { lat: -1.4, lon: 35.1 }, iptc: { title: 'Lion at dawn', keywords: ['lion'] } });
    await put('2023/Norway/plain.jpg', { pattern: 2 });
    const f = path.join(src, '2024/Kenya/lion.jpg'); const bytes = fs.readFileSync(f), mtime = fs.statSync(f).mtimeMs;
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.state).toBe('COMPLETED'); expect(r.counters).toMatchObject({ scanned: 2, new: 2, errors: 0 });
    const [p] = await q<Record<string, unknown>>(`SELECT p.*, v.camera_model, v.lens, v.iso, v.gps_lat, v.gps_source, v.deriv_status, v.state AS vstate, v.source_relpath, v.width, v.keywords, encode(v.content_sha256,'hex') AS sha FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE v.source_relpath = '2024/Kenya/lion.jpg'`);
    expect(p).toMatchObject({ title: 'Lion at dawn', title_source: 'IPTC', year: 2024, year_source: 'FOLDER_DERIVED', trip_location: 'Kenya', trip_location_source: 'FOLDER_DERIVED', capture_at_source: 'EXIF', camera_model: 'Canon EOS R5', iso: 800, gps_source: 'EXIF', deriv_status: 'PENDING', vstate: 'ACTIVE', width: 320 });
    expect(p!.keywords).toEqual(['lion']); expect(new Date(p!.capture_at as string).toISOString()).toBe('2024-03-12T06:30:00.000Z');
    expect(p!.sha).toBe((await sha256File(f)).toString('hex'));
    const plain = (await q<Record<string, unknown>>(`SELECT p.title, p.capture_at, p.year, p.year_source, p.trip_location FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE v.source_relpath = '2023/Norway/plain.jpg'`))[0]!;
    expect(plain).toMatchObject({ title: null, capture_at: null, year: 2023, year_source: 'FOLDER_DERIVED', trip_location: 'Norway' });     // nothing invented without EXIF
    expect(await n('jobs', `kind = 'derive.preview' AND state = 'QUEUED'`)).toBe(2); expect(await n('sync_events', `type = 'NEW_PHOTO'`)).toBe(2);
    const root = (await q<{ path: string; read_only: boolean }>(`SELECT path, read_only FROM library_roots`))[0]!; expect(root).toEqual({ path: src, read_only: true });
    expect(fs.readFileSync(f).equals(bytes)).toBe(true); expect(fs.statSync(f).mtimeMs).toBe(mtime); expect(files('2024/Kenya')).toEqual(['lion.jpg']);
  });

  it('is incremental: a second run reads nothing it already knows', async (ctx) => {
    need(ctx); for (let i = 0; i < 5; i++) await put(`2024/Kenya/p${i}.jpg`, { pattern: i });
    await ing().run(uid, src, 'APPLY');
    const r2 = await ing().run(uid, src, 'APPLY');
    expect(r2.counters).toMatchObject({ scanned: 5, unchanged: 5, new: 0, newVersions: 0, moved: 0, errors: 0 });
    expect(await n('photos')).toBe(5); expect(await n('jobs')).toBe(5);
    expect(await n('import_items', `run_id = '${r2.runId}'`)).toBe(0);                                  // unchanged files are counted, not listed
  });

  it('a corrupt file is reported and skipped; everything else is imported', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); fs.writeFileSync(path.join(src, 'broken.jpg'), 'not a jpeg at all'); await put('b.jpg', { pattern: 2 });
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.state).toBe('COMPLETED'); expect(r.counters).toMatchObject({ new: 2, errors: 1 });
    expect((await q<{ relpath: string; action: string }>(`SELECT relpath, action FROM import_items WHERE action = 'ERROR'`))[0]).toMatchObject({ relpath: 'broken.jpg' });
    expect(await n('photos')).toBe(2);
  });

  it('never leaves the source: links and RAW files are skipped and not imported', async (ctx) => {
    need(ctx); const outside = mk(); await makeJpeg(path.join(outside, 'secret.jpg'), { width: 200, height: 100 }); await put('ok.jpg', { pattern: 1 });
    fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(src, 'link.jpg')); fs.symlinkSync(outside, path.join(src, 'dir-link'));
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters.new).toBe(1); expect(r.counters.skipped.symlink).toBe(2);
    expect(await n('photo_versions', `source_relpath LIKE '%secret%' OR source_relpath LIKE 'dir-link%'`)).toBe(0);
  });
});

describe('re-exports, moves, duplicates and review', () => {
  it('a re-export over the same file name becomes version 2 of the SAME photograph; your data stays; going back restores version 1', async (ctx) => {
    need(ctx); await put('2024/Kenya/a.jpg', { pattern: 1 });
    await ing().run(uid, src, 'APPLY');
    const [ph] = await q<{ id: string; v: string }>(`SELECT id, current_version_id AS v FROM photos`);
    await h!.svc`UPDATE photos SET rating = 5, title = 'My title', title_source = 'USER_DEFINED', favorite = true WHERE id = ${ph!.id}`;
    const original = fs.readFileSync(path.join(src, '2024/Kenya/a.jpg'));
    await put('2024/Kenya/a.jpg', { pattern: 30, color: { r: 150, g: 50, b: 50 } });                  // Lightroom re-exports under the same name
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters).toMatchObject({ newVersions: 1, new: 0 });
    expect(await n('photos')).toBe(1);
    const vs = await q<{ version_no: number; state: string }>(`SELECT version_no, state FROM photo_versions ORDER BY version_no`);
    expect(vs.map((v) => [v.version_no, v.state])).toEqual([[1, 'SUPERSEDED'], [2, 'ACTIVE']]);
    expect((await q<Record<string, unknown>>(`SELECT rating, title, favorite, current_version_id <> '${ph!.v}' AS moved FROM photos`))[0]).toMatchObject({ rating: 5, title: 'My title', favorite: true, moved: true });
    expect(await n('jobs', `kind = 'derive.preview'`)).toBe(2);
    fs.writeFileSync(path.join(src, '2024/Kenya/a.jpg'), original);                                    // the old bytes come back
    const back = await ing().run(uid, src, 'APPLY');
    expect(back.counters.newVersions).toBe(1); expect(back.state).toBe('COMPLETED');
    expect((await q<{ version_no: number; state: string }>(`SELECT version_no, state FROM photo_versions ORDER BY version_no`)).map((v) => [v.version_no, v.state])).toEqual([[1, 'ACTIVE'], [2, 'SUPERSEDED']]);
    expect((await q<{ ok: boolean }>(`SELECT current_version_id = '${ph!.v}' AS ok FROM photos`))[0]!.ok).toBe(true);
  });

  it('a moved file keeps its photograph and edits; folder-derived facts follow it, your own values do not', async (ctx) => {
    need(ctx); await put('2024/Kenya/a.jpg', { pattern: 1 }); await put('2024/Kenya/b.jpg', { pattern: 2 });
    await ing().run(uid, src, 'APPLY');
    const [pa] = await q<{ id: string }>(`SELECT p.id FROM photos p JOIN photo_versions v ON v.photo_id = p.id WHERE v.source_relpath = '2024/Kenya/a.jpg'`);
    const [pb] = await q<{ id: string }>(`SELECT p.id FROM photos p JOIN photo_versions v ON v.photo_id = p.id WHERE v.source_relpath = '2024/Kenya/b.jpg'`);
    await h!.svc`UPDATE photos SET trip_location = 'Masai Mara', trip_location_source = 'USER_DEFINED', rating = 4 WHERE id = ${pb!.id}`;
    fs.mkdirSync(path.join(src, '2025/Tanzania'), { recursive: true });
    fs.renameSync(path.join(src, '2024/Kenya/a.jpg'), path.join(src, '2025/Tanzania/a.jpg')); fs.renameSync(path.join(src, '2024/Kenya/b.jpg'), path.join(src, '2025/Tanzania/b.jpg'));
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters).toMatchObject({ moved: 2, new: 0, missing: 0 }); expect(await n('photos')).toBe(2);
    const a = (await q<Record<string, unknown>>(`SELECT p.id, p.year, p.trip_location, v.source_relpath FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = '${pa!.id}'`))[0]!;
    expect(a).toMatchObject({ year: 2025, trip_location: 'Tanzania', source_relpath: '2025/Tanzania/a.jpg' });
    const b = (await q<Record<string, unknown>>(`SELECT p.year, p.trip_location, p.rating, v.source_relpath FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = '${pb!.id}'`))[0]!;
    expect(b).toMatchObject({ trip_location: 'Masai Mara', rating: 4, source_relpath: '2025/Tanzania/b.jpg' });      // the photographer's own location is untouched
  });

  it('a second copy of the same bytes is not imported twice: it goes to the review list', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); await ing().run(uid, src, 'APPLY');
    fs.copyFileSync(path.join(src, 'a.jpg'), path.join(src, 'a-copy.jpg'));
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters).toMatchObject({ duplicateFiles: 1, new: 0 }); expect(await n('photos')).toBe(1);
    const rq = await q<{ kind: string; subject: Record<string, string> }>(`SELECT kind, subject FROM review_queue`);
    expect(rq).toHaveLength(1); expect(rq[0]).toMatchObject({ kind: 'DUPLICATE_FILE', subject: { relpath: 'a-copy.jpg', sameAs: 'a.jpg' } });
    const again = await ing().run(uid, src, 'APPLY');                                                   // seen again each run, but asked about only once
    expect(again.counters.duplicateFiles).toBe(1); expect(await n('review_queue')).toBe(1);
  });

  it('same capture moment, different bytes → waits for your decision; SAME_PHOTO promotes it, DIFFERENT_PHOTO makes it its own photograph', async (ctx) => {
    need(ctx);
    await put('2024/Kenya/orig.jpg', { pattern: 1, captureAt: '2024:03:12 06:30:00', subsec: '25', make: 'Canon' });
    await put('2024/Kenya/reexport-edit.jpg', { pattern: 9, color: { r: 90, g: 60, b: 30 }, captureAt: '2024:03:12 06:30:00', subsec: '25', make: 'Canon' });
    await put('2024/Kenya/other-shot.jpg', { pattern: 15, color: { r: 30, g: 160, b: 60 }, captureAt: '2024:03:12 06:30:00', subsec: '25', make: 'Canon' });
    await ing().run(uid, src, 'APPLY');                                                                 // the first one imports; the others look like re-exports
    expect(await n('photos')).toBe(1); expect(await n('photo_versions', `state = 'PENDING_REVIEW'`)).toBe(2);
    const imports = new ImportsService(h!.app); const items = await imports.review(uid);
    expect(items.filter((i) => i.kind === 'VERSION_MATCH')).toHaveLength(2);
    const byPath = (rel: string) => items.find((i) => i.subject.relpath === rel)!;
    expect(await imports.decide(uid, byPath('2024/Kenya/reexport-edit.jpg').id, 'SAME_PHOTO')).toBe('ok');
    expect((await q<{ rp: string; state: string }>(`SELECT v.source_relpath AS rp, v.state FROM photos p JOIN photo_versions v ON v.id = p.current_version_id`))[0]).toMatchObject({ rp: '2024/Kenya/reexport-edit.jpg', state: 'ACTIVE' });
    expect(await imports.decide(uid, byPath('2024/Kenya/other-shot.jpg').id, 'DIFFERENT_PHOTO')).toBe('ok');
    expect(await n('photos')).toBe(2); expect(await n('photo_versions', `state = 'PENDING_REVIEW'`)).toBe(0);
    expect((await q<{ n: string }>(`SELECT count(*) AS n FROM photo_versions v JOIN photos p ON p.id = v.photo_id WHERE v.source_relpath = '2024/Kenya/other-shot.jpg' AND p.current_version_id = v.id AND v.version_no = 1`))[0]!.n).toBe('1');
    expect(await imports.decide(uid, byPath('2024/Kenya/other-shot.jpg').id, 'SAME_PHOTO')).toBe('not_found');     // already decided
    expect(await n('review_queue', `state = 'OPEN'`)).toBe(0);
  });
});

describe('files that disappear are flagged, never deleted', () => {
  it('SOURCE_MISSING keeps the record, the edits and the previews; the file coming back clears the flag', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); await put('b.jpg', { pattern: 2 });
    await ing().run(uid, src, 'APPLY'); await worker().drain();
    const [pa] = await q<{ id: string }>(`SELECT p.id FROM photos p JOIN photo_versions v ON v.photo_id = p.id WHERE v.source_relpath = 'a.jpg'`);
    await h!.svc`UPDATE photos SET rating = 5 WHERE id = ${pa!.id}`;
    const keep = fs.readFileSync(path.join(src, 'a.jpg')); fs.rmSync(path.join(src, 'a.jpg'));
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters).toMatchObject({ missing: 1, new: 0 });
    expect(await n('photos')).toBe(2); expect(await n('photo_versions', `source_relpath = 'a.jpg' AND NOT source_present`)).toBe(1);
    expect((await q<{ rating: number }>(`SELECT rating FROM photos WHERE id = '${pa!.id}'`))[0]!.rating).toBe(5);
    expect(fs.readdirSync(deriv).length).toBe(2);                                                       // previews kept
    expect(await n('sync_events', `type = 'SOURCE_MISSING'`)).toBe(1);
    fs.writeFileSync(path.join(src, 'a.jpg'), keep);
    const back = await ing().run(uid, src, 'APPLY');
    expect(back.counters.missing).toBe(0); expect(await n('photo_versions', `NOT source_present`)).toBe(0); expect(await n('photos')).toBe(2);
  });
  it('an unplugged or emptied source never flags anything on an incomplete scan; a dry run does not touch records', async (ctx) => {
    need(ctx); for (let i = 0; i < 3; i++) await put(`p${i}.jpg`, { pattern: i });
    await ing().run(uid, src, 'APPLY');
    const ac = new AbortController(); ac.abort();
    const r = await ing().run(uid, src, 'APPLY', ac.signal);
    expect(r.state).toBe('CANCELLED'); expect(await n('photo_versions', `NOT source_present`)).toBe(0);
    for (const f of fs.readdirSync(src)) fs.rmSync(path.join(src, f));
    const dry = await ing().run(uid, src, 'DRY_RUN');
    expect(dry.counters.missing).toBe(3); expect(await n('photo_versions', `NOT source_present`)).toBe(0);
  });
});

describe('interruption and recovery', () => {
  it('an interrupted import can be resumed: finished files are not redone, the rest are imported', async (ctx) => {
    need(ctx); for (let i = 0; i < 10; i++) await put(`f${String(i).padStart(2, '0')}.jpg`, { pattern: i, width: 160, height: 120 });
    const ac = new AbortController();
    const r1 = await ing({ concurrency: 2, onBatch: (c: Counters) => { if (c.new >= 4) ac.abort(); } }).run(uid, src, 'APPLY', ac.signal);
    expect(r1.state).toBe('CANCELLED'); const partial = await n('photos'); expect(partial).toBeGreaterThanOrEqual(4); expect(partial).toBeLessThan(10);
    const r2 = await ing().run(uid, src, 'APPLY');
    expect(r2.state).toBe('COMPLETED'); expect(r2.counters.unchanged).toBe(partial); expect(r2.counters.new).toBe(10 - partial); expect(await n('photos')).toBe(10);
    expect(await n('jobs', `kind = 'derive.preview'`)).toBe(10);                                        // exactly one preview job per version
  });
  it('a run whose process died is shown as INTERRUPTED, and the next run records that it resumed it', async (ctx) => {
    need(ctx); await put('a.jpg');
    const [root] = await h!.svc<{ id: string }[]>`INSERT INTO library_roots (user_id, path) VALUES (${uid}, ${src}) RETURNING id`;
    const [dead] = await h!.svc<{ id: string }[]>`INSERT INTO import_runs (user_id, library_root_id, mode, source_path, heartbeat_at) VALUES (${uid}, ${root!.id}, 'APPLY', ${src}, now() - interval '1 hour') RETURNING id`;
    expect(await ing().recover(uid)).toBe(1);
    expect((await q<{ state: string }>(`SELECT state FROM import_runs WHERE id = '${dead!.id}'`))[0]!.state).toBe('INTERRUPTED');
    const r = await ing().run(uid, src, 'APPLY');
    expect((await q<{ resumed_from: string }>(`SELECT resumed_from FROM import_runs WHERE id = '${r.runId}'`))[0]!.resumed_from).toBe(dead!.id);
    expect(await ing().recover(uid)).toBe(0);
  });
  it('the progress record is written while the run is still going', async (ctx) => {
    need(ctx); for (let i = 0; i < 6; i++) await put(`g${i}.jpg`, { pattern: i, width: 120, height: 90 });
    let seen = 0;
    await ing({ concurrency: 1, onBatch: async () => { await new Promise((r) => setTimeout(r, 20)); /* let the (10 ms) heartbeat interval elapse so the test does not depend on machine speed */ const [r] = await q<{ counters: { scanned: number }; state: string }>(`SELECT counters, state FROM import_runs ORDER BY started_at DESC LIMIT 1`); if (r!.state === 'RUNNING' && r!.counters.scanned > 0) seen++; } }).run(uid, src, 'APPLY');
    expect(seen).toBeGreaterThan(0);
  });
});

describe('preview worker', () => {
  it('derives previews and fingerprints, marks versions READY and finds near-duplicates', async (ctx) => {
    need(ctx);
    await makeJpeg(path.join(src, 'a.jpg'), { width: 1200, height: 800, pattern: 3, color: { r: 40, g: 90, b: 140 } });
    await sharp(path.join(src, 'a.jpg')).resize(900, 600).jpeg({ quality: 90 }).toFile(path.join(src, 'a-web.jpg'));          // the same picture, exported smaller
    await makeJpeg(path.join(src, 'z.jpg'), { width: 1200, height: 800, pattern: 41, color: { r: 200, g: 60, b: 30 } });
    await ing().run(uid, src, 'APPLY');
    expect(await worker().drain()).toBe(3);
    expect(await n('photo_versions', `deriv_status = 'READY' AND phash IS NOT NULL AND dhash IS NOT NULL AND dominant_colors IS NOT NULL`)).toBe(3);
    for (const v of await q<{ id: string }>(`SELECT id FROM photo_versions`)) { expect(fs.existsSync(path.join(deriv, v.id, 'thumb.jpg'))).toBe(true); expect(fs.existsSync(path.join(deriv, v.id, 'view.jpg'))).toBe(true); }
    expect(await n('jobs', `state = 'SUCCEEDED'`)).toBe(3);
    const pairs = await q<{ distance: number }>(`SELECT distance FROM duplicate_pairs WHERE state = 'OPEN'`);
    expect(pairs).toHaveLength(1); expect(pairs[0]!.distance).toBeLessThanOrEqual(6);
  });
  it('retries a transient failure with backoff, then succeeds; a permanently failing job ends DEAD with the version marked FAILED', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); await ing().run(uid, src, 'APPLY');
    const keep = fs.readFileSync(path.join(src, 'a.jpg')); fs.rmSync(path.join(src, 'a.jpg'));           // the drive "goes away"
    const w = worker(1);
    expect(await w.runOnce()).toBe(1);
    const [j] = await q<{ state: string; attempts: number; last_error: string }>(`SELECT state, attempts, last_error FROM jobs`);
    expect(j).toMatchObject({ state: 'QUEUED', attempts: 1 }); expect(j!.last_error).toMatch(/not available/);
    fs.writeFileSync(path.join(src, 'a.jpg'), keep);                                                       // it comes back
    await h!.svc`UPDATE jobs SET run_after = now()`; expect(await w.drain()).toBe(1);
    expect((await q<{ deriv_status: string }>(`SELECT deriv_status FROM photo_versions`))[0]!.deriv_status).toBe('READY');
    // permanent: the file keeps being unavailable until attempts run out
    await put('b.jpg', { pattern: 2 }); await ing().run(uid, src, 'APPLY'); await h!.svc`UPDATE jobs SET max_attempts = 2 WHERE state = 'QUEUED'`;
    fs.rmSync(path.join(src, 'b.jpg'));
    for (let i = 0; i < 3; i++) { await h!.svc`UPDATE jobs SET run_after = now() WHERE state = 'QUEUED'`; await w.runOnce(); }
    expect((await q<{ state: string }>(`SELECT j.state FROM jobs j WHERE j.payload ->> 'versionId' IN (SELECT id::text FROM photo_versions WHERE source_relpath = 'b.jpg')`))[0]!.state).toBe('DEAD');
    expect((await q<{ deriv_status: string }>(`SELECT deriv_status FROM photo_versions WHERE source_relpath = 'b.jpg'`))[0]!.deriv_status).toBe('FAILED');
    const imports = new ImportsService(h!.app); expect((await imports.queue(uid)).failed).toHaveLength(1);
    fs.writeFileSync(path.join(src, 'b.jpg'), fs.readFileSync(path.join(src, 'a.jpg')));                  // (any valid JPEG with the right bytes is needed: restore properly below)
  });
  it('refuses to derive from a file that changed after it was imported (it will arrive as a new version instead)', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); await ing().run(uid, src, 'APPLY');
    await put('a.jpg', { pattern: 20, color: { r: 10, g: 200, b: 10 } });
    await worker(1).runOnce();
    expect((await q<{ state: string; last_error: string }>(`SELECT state, last_error FROM jobs`))[0]).toMatchObject({ state: 'FAILED' });
    expect((await q<{ deriv_status: string }>(`SELECT deriv_status FROM photo_versions`))[0]!.deriv_status).toBe('FAILED');
    const r = await ing().run(uid, src, 'APPLY'); expect(r.counters.newVersions).toBe(1);
    await worker().drain(); expect(await n('photo_versions', `deriv_status = 'READY'`)).toBe(1);
  });
  it('a crashed worker loses nothing: an expired lease puts the job back; retrying failed jobs re-queues them', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); await ing().run(uid, src, 'APPLY');
    await h!.svc`UPDATE jobs SET state = 'RUNNING', locked_by = 'dead-worker', locked_until = now() - interval '1 minute', attempts = 1`;
    expect(await worker().drain()).toBe(1); expect(await n('photo_versions', `deriv_status = 'READY'`)).toBe(1);
    await h!.svc`UPDATE jobs SET state = 'DEAD'`; await h!.svc`UPDATE photo_versions SET deriv_status = 'FAILED'`;
    expect(await new ImportsService(h!.app).retryFailed(uid)).toBe(1);
    expect(await n('jobs', `state = 'QUEUED'`)).toBe(1); expect(await n('photo_versions', `deriv_status = 'PENDING'`)).toBe(1);
  });
});

describe('ownership', () => {
  it('another account sees none of my runs, items, review entries or queue', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 1 }); await put('b.jpg', { pattern: 1, captureAt: '2024:01:01 01:01:01' }); await ing().run(uid, src, 'APPLY');
    const other = await makeUser(h!.svc, 'other@example.test'); const imports = new ImportsService(h!.app);
    expect(await imports.runs(other)).toEqual([]); expect((await imports.queue(other)).derivatives).toMatchObject({ pending: 0, ready: 0 });
    expect(await imports.review(other)).toEqual([]); expect(await imports.run(other, (await imports.runs(uid))[0]!.id, { limit: 10 })).toBeNull();
    expect((await imports.runs(uid)).length).toBe(1); void approvalPath;
  });

  it('the worker (whose database role is not row-restricted) never pairs photographs across accounts, even when two accounts hold identical files', async (ctx) => {
    need(ctx); await put('a.jpg', { pattern: 3, width: 1200, height: 800, color: { r: 40, g: 90, b: 140 } }); await put('b.jpg', { pattern: 41, width: 1200, height: 800, color: { r: 200, g: 60, b: 30 } });
    const other = await makeUser(h!.svc, 'second@example.test');
    await ing().run(uid, src, 'APPLY'); await ing().run(other, src, 'APPLY');            // the same two files imported by two accounts
    expect(await worker().drain()).toBe(4);
    expect(await n('jobs', `kind = 'derive.preview' AND state = 'SUCCEEDED'`)).toBe(4); expect(await n('jobs', `kind = 'derive.preview' AND state <> 'SUCCEEDED'`)).toBe(0);
    expect(await n('duplicate_pairs')).toBe(0);                                          // identical files in DIFFERENT accounts are not duplicates of each other
    await ing().run(uid, src, 'APPLY'); fs.copyFileSync(path.join(src, 'a.jpg'), path.join(src, 'c.jpg'));
    await ing().run(uid, src, 'APPLY'); await worker().drain();                          // a second copy → duplicate FILE (not imported twice), still no pair
    expect(await n('duplicate_pairs')).toBe(0);
  });
});
