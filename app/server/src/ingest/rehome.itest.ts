import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderMetadata } from '@photovault/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { IngestService } from './service.js';
import { makeJpeg } from './testkit.js';

/**
 * Production regression: the first batch was imported with …/2026/DC as the scan root, so the photographs lost their folder path. Scanning the real
 * root afterwards must re-home them (same photograph, same edits) rather than import them a second time.
 */
let h: Handles | null; let uid: string; let src: string; let deriv: string;
const dirs: string[] = [];
const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-rehome-'))); dirs.push(d); return d; };
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const ing = () => new IngestService({ sql: h!.app, policy: { approved: [{ path: src, modes: ['DRY_RUN', 'APPLY'], approvedAt: 't' }, { path: path.join(src, '2026', 'DC'), modes: ['DRY_RUN', 'APPLY'], approvedAt: 't' }] }, derivativesDir: deriv, heartbeatMs: 10 });
const put = (rel: string, seed: number) => makeJpeg(path.join(src, rel), { width: 320 + seed, height: 214 + seed });
const q = async <T extends object = Record<string, never>>(text: string): Promise<T[]> => (await h!.svc.unsafe(text)) as unknown as T[];

beforeAll(async () => { h = await tryHandles(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
beforeEach(async () => { if (!h) return; await wipe(h.svc); uid = await makeUser(h.svc, 'owner@example.test'); src = mk(); deriv = mk(); });

const setup = async () => {
  await put('2026/DC/a.jpg', 1); await put('2026/DC/b.jpg', 2);
  const first = await ing().run(uid, path.join(src, '2026', 'DC'), 'APPLY');                 // the earlier, narrower scan
  expect(first.counters.new).toBe(2);
  const before = await q<{ id: string; photo_id: string }>(`SELECT id, photo_id FROM photo_versions ORDER BY source_relpath`);
  await put('2026/India/c.jpg', 3); await put('2025/Chicago/d.jpg', 4);
  return before;
};

describe('re-homing photographs recorded under a narrower root', () => {
  it('a dry run predicts the re-homing and writes nothing', async (ctx) => {
    need(ctx); await setup();
    const r = await ing().run(uid, src, 'DRY_RUN');
    expect(r.state).toBe('COMPLETED');
    expect(r.counters).toMatchObject({ new: 2, moved: 2, duplicateFiles: 0, versionReview: 0, missing: 0 });
    expect((await q<{ n: string }>(`SELECT count(*) n FROM photo_versions WHERE library_root_id IN (SELECT id FROM library_roots WHERE path = '${src}/2026/DC')`))[0]!.n).toBe('2');
  });

  it('an import keeps photograph ids, edits and manual location, and fixes the folder path', async (ctx) => {
    need(ctx); const before = await setup();
    const a = before[0]!;
    await q(`UPDATE photos SET trip_location = 'Washington, D.C.', trip_location_source = 'USER_DEFINED', place_city = 'Washington', place_source = 'USER_DEFINED', title = 'My title', title_source = 'USER_DEFINED' WHERE id = '${a.photo_id}'`);
    await q(`UPDATE photo_versions SET gps_lat = 38.9, gps_lon = -77.0, gps_source = 'USER_DEFINED' WHERE photo_id = '${a.photo_id}'`);
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters).toMatchObject({ new: 2, moved: 2, duplicateFiles: 0, versionReview: 0, missing: 0, errors: 0 });
    const after = await q<{ id: string; photo_id: string; source_relpath: string; root: string }>(`SELECT v.id, v.photo_id, v.source_relpath, r.path AS root FROM photo_versions v JOIN library_roots r ON r.id = v.library_root_id ORDER BY v.source_relpath`);
    expect(after).toHaveLength(4);
    expect(after.filter((x) => x.root === src)).toHaveLength(4);
    const re = after.find((x) => x.id === a.id)!;
    expect(re.photo_id).toBe(a.photo_id); expect(re.source_relpath).toBe('2026/DC/a.jpg');
    expect((await q<{ n: string }>(`SELECT count(*) n FROM photos`))[0]!.n).toBe('4');            // no duplicates
    const p = (await q<{ trip_location: string; title: string; subpath: string | null; year: number | null }>(`SELECT trip_location, title, subpath, year FROM photos WHERE id = '${a.photo_id}'`))[0]!;
    expect(p.trip_location).toBe('Washington, D.C.'); expect(p.title).toBe('My title');         // the photographer's edits survive
    expect(p.subpath).toBe(folderMetadata('2026/DC/a.jpg').subpath);                              // the folder position follows the file
    const g = (await q<{ gps_lat: number; gps_source: string }>(`SELECT gps_lat, gps_source FROM photo_versions WHERE id = '${a.id}'`))[0]!;
    expect(Number(g.gps_lat)).toBeCloseTo(38.9); expect(g.gps_source).toBe('USER_DEFINED');
    // the untouched one follows its folder
    const b = (await q<{ trip_location: string | null; year: number | null }>(`SELECT trip_location, year FROM photos WHERE id = '${before[1]!.photo_id}'`))[0]!;
    expect(b.year).toBe(folderMetadata('2026/DC/b.jpg').year);
    expect(b.trip_location).toBe(folderMetadata('2026/DC/b.jpg').location);
    // previews already made keep working: the version id (their key) did not change, and its job is not queued again
    expect((await q<{ n: string }>(`SELECT count(*) n FROM jobs WHERE kind = 'derive.preview'`))[0]!.n).toBe('4');
  });

  it('running it again changes nothing, and a second scan never re-homes twice', async (ctx) => {
    need(ctx); await setup(); await ing().run(uid, src, 'APPLY');
    const again = await ing().run(uid, src, 'APPLY');
    expect(again.counters).toMatchObject({ new: 0, moved: 0, duplicateFiles: 0, missing: 0 });
    expect(again.counters.unchanged).toBe(4);
  });

  it('a file that is not in the narrower root is never confused with one that is', async (ctx) => {
    need(ctx); await put('2026/DC/a.jpg', 1);
    await ing().run(uid, path.join(src, '2026', 'DC'), 'APPLY');
    fs.rmSync(path.join(src, '2026', 'DC', 'a.jpg'));                                                // the file has gone: the record is flagged by the narrower scan only, never deleted
    await put('2026/other/z.jpg', 9);
    const r = await ing().run(uid, src, 'APPLY');
    expect(r.counters).toMatchObject({ new: 1, moved: 0, missing: 0 });
    expect((await q<{ n: string }>(`SELECT count(*) n FROM photos`))[0]!.n).toBe('2');
  });
});
