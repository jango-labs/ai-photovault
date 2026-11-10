import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { approvalPath } from './approval.js';
import { scheduledScan, sourceConfigFromEnv, sourceInfo, type SourceConfig } from './source.js';
import { makeJpeg } from './testkit.js';

let h: Handles | null; let uid: string; let src: string; let state: string; let deriv: string;
const dirs: string[] = [];
const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-source-'))); dirs.push(d); return d; };
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const approve = (modes: string[] = ['DRY_RUN', 'APPLY']) => { fs.mkdirSync(path.dirname(approvalPath(state)), { recursive: true }); fs.writeFileSync(approvalPath(state), JSON.stringify({ roots: [{ path: src, modes, approvedAt: 't' }] })); };
const cfg = (o: Partial<SourceConfig> = {}): SourceConfig => ({ name: 'MyPhotos', dir: src, intervalMin: 60, ...o });
const put = (rel: string, seed: number) => makeJpeg(path.join(src, rel), { width: 320 + seed, height: 214 + seed });
const scan = (c = cfg(), now?: Date) => scheduledScan({ sql: h!.svc, cfg: c, stateDir: state, derivativesDir: deriv, ...(now ? { now: () => now } : {}) });
const n = async (t: string) => Number(((await h!.svc.unsafe(`SELECT count(*) n FROM ${t}`)) as unknown as Array<{ n: string }>)[0]!.n);

beforeAll(async () => { h = await tryHandles(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
beforeEach(async () => { if (!h) return; await wipe(h.svc); uid = await makeUser(h.svc, 'owner@example.test'); src = mk(); state = mk(); deriv = mk(); });

describe('source configuration', () => {
  it('reads the folder, name and interval from the environment, with safe bounds', () => {
    expect(sourceConfigFromEnv({})).toBeNull();
    expect(sourceConfigFromEnv({ PHOTOVAULT_INGEST_DIR: '/a/MyPhotos/' })).toEqual({ name: 'MyPhotos', dir: '/a/MyPhotos/', intervalMin: 360 });
    expect(sourceConfigFromEnv({ PHOTOVAULT_INGEST_DIR: '/a/b', PHOTOVAULT_INGEST_NAME: 'Mine', PHOTOVAULT_SCAN_INTERVAL_MIN: '1' })).toMatchObject({ name: 'Mine', intervalMin: 15 });
    expect(sourceConfigFromEnv({ PHOTOVAULT_INGEST_DIR: '/a/b', PHOTOVAULT_SCAN_INTERVAL_MIN: '0' })!.intervalMin).toBe(0);
    expect(sourceConfigFromEnv({ PHOTOVAULT_INGEST_DIR: '/a/b', PHOTOVAULT_SCAN_INTERVAL_MIN: 'x' })!.intervalMin).toBe(0);
  });
});

describe('scheduled scan', () => {
  it('does nothing when scanning is off, unapproved, or the source is unavailable or empty — and writes nothing', async (ctx) => {
    need(ctx); await put('2026/DC/a.jpg', 1);
    expect(await scan(cfg({ intervalMin: 0 }))).toMatchObject({ ran: false, reason: expect.stringMatching(/off/) });
    expect(await scan()).toMatchObject({ ran: false, reason: expect.stringMatching(/not been approved/) });
    approve(['DRY_RUN']);
    expect(await scan()).toMatchObject({ ran: false, reason: expect.stringMatching(/not been approved/) });          // a dry-run approval is not an import approval
    approve();
    expect(await scan(cfg({ dir: path.join(src, 'nope') }))).toMatchObject({ ran: false, reason: expect.stringMatching(/unavailable/) });
    const empty = mk(); expect(await scan(cfg({ dir: empty }))).toMatchObject({ ran: false, reason: expect.stringMatching(/unavailable/) });
    expect(await n('import_runs')).toBe(0); expect(await n('photos')).toBe(0);
  });

  it('imports what is new, skips when the last scan is recent, and picks up later additions and renames without duplicating', async (ctx) => {
    need(ctx); approve(); await put('2026/DC/a.jpg', 1); await put('2025/Chicago/b.jpg', 2);
    const t0 = new Date();
    const first = await scan(cfg(), t0);
    expect(first.ran && first.result.counters).toMatchObject({ new: 2, errors: 0 });
    expect(await n('photos')).toBe(2);
    expect(await scan(cfg(), new Date(t0.getTime() + 10 * 60_000))).toMatchObject({ ran: false, reason: expect.stringMatching(/recent/) });
    // a new export arrives and a file is renamed; the next due scan finds exactly those
    await put('2026/India/c.jpg', 3); fs.renameSync(path.join(src, '2025/Chicago/b.jpg'), path.join(src, '2025/Chicago/b-renamed.jpg'));
    const ids = ((await h!.svc.unsafe(`SELECT id FROM photos ORDER BY id`)) as unknown as Array<{ id: string }>).map((x) => x.id);
    const second = await scan(cfg(), new Date(t0.getTime() + 61 * 60_000));
    expect(second.ran && second.result.counters).toMatchObject({ new: 1, moved: 1, unchanged: 1, errors: 0, missing: 0 });
    expect(await n('photos')).toBe(3);
    const after = ((await h!.svc.unsafe(`SELECT id FROM photos ORDER BY id`)) as unknown as Array<{ id: string }>).map((x) => x.id);
    for (const id of ids) expect(after).toContain(id);                                                                // the original photographs keep their ids
    // the source files were never touched
    expect(fs.readdirSync(path.join(src, '2025/Chicago'))).toEqual(['b-renamed.jpg']);
  });

  it('never runs while another import is active', async (ctx) => {
    need(ctx); approve(); await put('a.jpg', 1);
    const [root] = (await h!.svc.unsafe(`INSERT INTO library_roots (user_id, path) VALUES ('${uid}', '${src}') RETURNING id`)) as unknown as Array<{ id: string }>;
    await h!.svc.unsafe(`INSERT INTO import_runs (user_id, library_root_id, mode, source_path, state, heartbeat_at) VALUES ('${uid}', '${root!.id}', 'APPLY', '${src}', 'RUNNING', now())`);
    expect(await scan()).toMatchObject({ ran: false, reason: expect.stringMatching(/already running/) });
  });

  it('reports the source for the Imports page: availability, counts, last scan and the next one', async (ctx) => {
    need(ctx); approve(); await put('2026/DC/a.jpg', 1); await put('2026/DC/b.jpg', 2);
    let info = await sourceInfo(h!.app, uid, cfg());
    expect(info).toMatchObject({ name: 'MyPhotos', mode: 'Read only', type: 'Local folder', available: true, imported: 0, lastScanAt: null, scanning: false });
    await scan();
    info = await sourceInfo(h!.app, uid, cfg());
    expect(info).toMatchObject({ discovered: 2, imported: 2, skipped: 0, lastScan: { new: 2, unchanged: 0, failed: 0 }, lastScanState: 'COMPLETED' });
    expect(info.lastScanAt).not.toBeNull(); expect(new Date(info.nextScanAt!).getTime()).toBeGreaterThan(new Date(info.lastScanAt!).getTime());
    info = await sourceInfo(h!.app, uid, cfg({ dir: path.join(src, 'gone') }));
    expect(info).toMatchObject({ available: false, nextScanAt: null }); expect(info.unavailableReason).toMatch(/not there/);
  });
});
