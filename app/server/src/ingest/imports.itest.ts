import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { JobWorker } from '../jobs/worker.js';
import { approvalPath } from './approval.js';
import { deriveHandler } from './derive-job.js';
import { makeJpeg } from './testkit.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let src: string, state: string, deriv: string;
const dirs: string[] = [];
const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-imp-'))); dirs.push(d); return d; };
const approve = (modes: string[]) => { fs.mkdirSync(path.join(state, 'approvals'), { recursive: true }); fs.writeFileSync(approvalPath(state), JSON.stringify({ roots: [{ path: src, modes, approvedAt: new Date().toISOString() }] })); };
const settle = async (id: string) => { for (let i = 0; i < 100; i++) { const r = (await A.json('GET', `/api/imports/runs/${id}`)).body; if (r.run.state !== 'RUNNING') return r; await new Promise((x) => setTimeout(x, 50)); } throw new Error('run did not finish'); };

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); src = mk(); state = mk(); deriv = mk();
  app = makeApp(h, { stateDir: state, ingestDir: src, derivativesDir: deriv });
  await makeUser(h.svc, 'a@example.test'); await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
  for (let i = 0; i < 4; i++) await makeJpeg(path.join(src, `2024/Kenya/p${i}.jpg`), { width: 200, height: 140, pattern: i });
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('Imports API', () => {
  it('every endpoint needs a session; changes also need CSRF', async (ctx) => {
    need(ctx); const anon = new ApiClient(app);
    for (const [m, u, b] of [['GET', '/api/imports/status'], ['GET', '/api/imports/runs'], ['GET', '/api/imports/review'], ['POST', '/api/imports/runs', { mode: 'DRY_RUN' }], ['POST', '/api/imports/jobs/retry', {}]] as Array<['GET' | 'POST', string, unknown?]>)
      expect((await anon.json(m, u, b)).status, `${m} ${u}`).toBe(401);
    expect((await A.req('POST', '/api/imports/runs', { mode: 'DRY_RUN' }, { csrf: false })).statusCode).toBe(403);
  });

  it('without the owner’s approval nothing can be scanned, not even a dry run, and nothing is recorded', async (ctx) => {
    need(ctx);
    const st = (await A.json('GET', '/api/imports/status')).body;
    expect(st.source).toMatchObject({ configured: src, dryRunApproved: false, applyApproved: false }); expect(st.lastRun).toBeNull();
    for (const mode of ['DRY_RUN', 'APPLY']) { const r = await A.json('POST', '/api/imports/runs', { mode }); expect(r.status).toBe(403); expect(r.body.error).toBe('not_approved'); }
    expect((await h!.svc`SELECT count(*)::int AS n FROM import_runs`)[0]!.n).toBe(0);
  });

  it('with a dry-run approval: a dry run works, an import is still refused', async (ctx) => {
    need(ctx); approve(['DRY_RUN']);
    expect((await A.json('GET', '/api/imports/status')).body.source).toMatchObject({ dryRunApproved: true, applyApproved: false });
    const start = await A.json('POST', '/api/imports/runs', { mode: 'DRY_RUN' }); expect(start.status).toBe(202);
    const done = await settle(start.body.runId);
    expect(done.run).toMatchObject({ mode: 'DRY_RUN', state: 'COMPLETED' }); expect(done.run.counters).toMatchObject({ scanned: 4, new: 4 }); expect(done.byAction).toEqual({ NEW: 4 });
    expect((await h!.svc`SELECT count(*)::int AS n FROM photos`)[0]!.n).toBe(0);
    expect((await A.json('POST', '/api/imports/runs', { mode: 'APPLY' })).status).toBe(403);
  });

  it('with an import approval: runs in the background, reports progress, lists items, then previews are processed', async (ctx) => {
    need(ctx); approve(['DRY_RUN', 'APPLY']);
    const start = await A.json('POST', '/api/imports/runs', { mode: 'APPLY' }); expect(start.status).toBe(202);
    const done = await settle(start.body.runId);
    expect(done.run.state).toBe('COMPLETED'); expect(done.run.counters).toMatchObject({ scanned: 4, new: 4, errors: 0, complete: true });
    const items = (await A.json('GET', `/api/imports/runs/${start.body.runId}?action=NEW&limit=2`)).body;
    expect(items.items).toHaveLength(2); expect(items.nextAfter).toBeTruthy();
    expect((await A.json('GET', `/api/imports/runs/${start.body.runId}?action=NEW&limit=2&after=${items.nextAfter}`)).body.items).toHaveLength(2);
    expect((await A.json('GET', '/api/imports/runs')).body.runs.map((r: { mode: string }) => r.mode)).toEqual(['APPLY', 'DRY_RUN']);
    let q = (await A.json('GET', '/api/imports/status')).body.queue; expect(q.derivatives).toMatchObject({ pending: 4, ready: 0 }); expect(q.jobs).toContainEqual({ kind: 'derive.preview', state: 'QUEUED', n: 4 });
    await new JobWorker(h!.svc, { 'derive.preview': deriveHandler(h!.svc, deriv) }, { concurrency: 2 }).drain();
    q = (await A.json('GET', '/api/imports/status')).body.queue; expect(q.derivatives).toMatchObject({ pending: 0, ready: 4, failed: 0 });
    // the library now serves previews for them
    const list = (await A.json('GET', '/api/library/photos?limit=10')).body; expect(list.total).toBe(4);
    const img = await A.req('GET', `/api/library/photos/${list.items[0].id}/image?size=thumb`); expect(img.statusCode).toBe(200); expect(img.headers['content-type']).toBe('image/jpeg');
  });

  it('only one import at a time; a running import can be cancelled; unknown runs are 404', async (ctx) => {
    need(ctx);
    for (let i = 0; i < 40; i++) await makeJpeg(path.join(src, `2025/Bulk/b${i}.jpg`), { width: 400, height: 300, pattern: i + 10, color: { r: i * 5, g: 80, b: 120 } });
    const first = await A.json('POST', '/api/imports/runs', { mode: 'APPLY' }); expect(first.status).toBe(202);
    const second = await A.json('POST', '/api/imports/runs', { mode: 'DRY_RUN' }); expect(second.status).toBe(409); expect(second.body.error).toBe('already_running');
    expect((await A.json('POST', `/api/imports/runs/${first.body.runId}/cancel`)).status).toBeLessThan(500);
    const done = await settle(first.body.runId); expect(['CANCELLED', 'COMPLETED']).toContain(done.run.state);
    expect((await A.json('POST', '/api/imports/runs/00000000-0000-4000-8000-000000000000/cancel')).status).toBe(404);
    expect((await A.json('GET', '/api/imports/runs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await A.json('POST', '/api/imports/runs', { mode: 'DELETE' })).status).toBe(400); expect((await A.json('GET', '/api/imports/runs/x')).status).toBe(400);
    const finish = await A.json('POST', '/api/imports/runs', { mode: 'APPLY' }); await settle(finish.body.runId);
    expect((await h!.svc`SELECT count(*)::int AS n FROM photos`)[0]!.n).toBe(44);
  });

  it('the review queue and failed-preview retry work through the API', async (ctx) => {
    need(ctx);
    fs.copyFileSync(path.join(src, '2024/Kenya/p0.jpg'), path.join(src, '2024/Kenya/p0-copy.jpg'));
    const r = await A.json('POST', '/api/imports/runs', { mode: 'APPLY' }); await settle(r.body.runId);
    const review = (await A.json('GET', '/api/imports/review')).body.items; expect(review).toHaveLength(1); expect(review[0]).toMatchObject({ kind: 'DUPLICATE_FILE' });
    expect((await A.json('POST', `/api/imports/review/${review[0].id}`, { decision: 'SAME_PHOTO' })).status).toBe(400);
    expect((await B.json('POST', `/api/imports/review/${review[0].id}`, { decision: 'ACKNOWLEDGE' })).status).toBe(404);   // not B's
    expect((await A.json('POST', `/api/imports/review/${review[0].id}`, { decision: 'ACKNOWLEDGE' })).status).toBe(200);
    expect((await A.json('GET', '/api/imports/review')).body.items).toHaveLength(0);
    await h!.svc`UPDATE jobs SET state = 'DEAD' WHERE kind = 'derive.preview'`;
    expect((await A.json('POST', '/api/imports/jobs/retry', {})).body.requeued).toBeGreaterThan(0);
  });

  it('another account sees none of it', async (ctx) => {
    need(ctx);
    expect((await B.json('GET', '/api/imports/runs')).body.runs).toEqual([]); expect((await B.json('GET', '/api/imports/status')).body.lastRun).toBeNull();
    const runId = (await A.json('GET', '/api/imports/runs')).body.runs[0].id; expect((await B.json('GET', `/api/imports/runs/${runId}`)).status).toBe(404);
    expect((await B.json('GET', '/api/library/photos?limit=5')).body.total).toBe(0);
  });
});
