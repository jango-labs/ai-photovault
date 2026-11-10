import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let aId = '', bId = '';
const photos: Array<{ photoId: string; versionId: string }> = [];
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); aId = await makeUser(h.svc, 'q1@example.test'); bId = await makeUser(h.svc, 'q2@example.test');
  app = makeApp(h); A = await new ApiClient(app).signIn('q1@example.test'); B = await new ApiClient(app).signIn('q2@example.test');
  for (let i = 0; i < 4; i++) photos.push(await seedOne(h.svc, aId, { title: `Queue photo ${i}`, year: 2024 }));
  for (const [i, p] of photos.entries()) {
    await h.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${aId}, 'ai.analyze', ${h.svc.json({ photoId: p.photoId, versionId: p.versionId })}, ${`a${i}`})`;
    await h.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${aId}, 'embed.image', ${h.svc.json({ versionId: p.versionId })}, ${`e${i}`})`;
  }
  await h.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${aId}, 'derive.preview', '{}'::jsonb, 'd0')`;
  await h.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${bId}, 'ai.analyze', '{}'::jsonb, 'b0')`;
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('AI processing queue controls', () => {
  it('requires sign-in and refuses malformed requests', async (ctx) => {
    need(ctx); const anon = new ApiClient(app);
    for (const [m, u] of [['GET', '/api/ai/queue'], ['GET', '/api/ai/queue/history'], ['POST', '/api/ai/queue/pause'], ['POST', '/api/ai/queue/cancel']] as const) expect((await anon.req(m, u, m === 'POST' ? {} : undefined)).statusCode, u).toBe(401);
    expect((await A.json('POST', '/api/ai/queue/pause', { queue: 'everything' })).status).toBe(400);
    expect((await A.json('POST', '/api/ai/queue/pause', { queue: 'ai', extra: 1 })).status).toBe(400);
    expect((await A.json('POST', '/api/ai/queue/prioritize', { photoIds: ['not-a-uuid'] })).status).toBe(400);
    expect((await A.json('POST', '/api/ai/queue/prioritize', {})).status).toBe(400);
  });
  it('reports what is waiting, only the AI kinds, only this account', async (ctx) => {
    need(ctx); const s = (await A.json('GET', '/api/ai/queue')).body;
    expect(s).toMatchObject({ paused: false, previewsPaused: false, waiting: 8, running: 0, prioritised: 0 });
    expect(s.perKind).toEqual([{ kind: 'ai.analyze', waiting: 4, running: 0 }, { kind: 'embed.image', waiting: 4, running: 0 }]);
    expect((await B.json('GET', '/api/ai/queue')).body.waiting).toBe(1);
  });
  it('pause and resume are stored per account and per queue, and the claim function honours them', async (ctx) => {
    need(ctx); expect((await A.json('POST', '/api/ai/queue/pause', {})).body).toMatchObject({ paused: true, previewsPaused: false });
    const claimed = await h!.svc<{ kind: string; user_id: string }[]>`SELECT kind, user_id FROM claim_jobs('t', ARRAY['ai.analyze','embed.image','derive.preview'], 50, interval '1 minute')`;
    expect(claimed.filter((j) => j.user_id === aId).map((j) => j.kind)).toEqual(['derive.preview']);                         // A's analysis is held, A's previews and B's analysis run
    expect(claimed.filter((j) => j.user_id === bId).map((j) => j.kind)).toEqual(['ai.analyze']);
    await h!.svc`UPDATE jobs SET state = 'QUEUED', locked_by = NULL, locked_until = NULL, attempts = 0 WHERE state = 'RUNNING'`;
    expect((await A.json('POST', '/api/ai/queue/resume', {})).body.paused).toBe(false);
    expect((await h!.svc`SELECT count(*)::int AS n FROM claim_jobs('t', ARRAY['ai.analyze','embed.image'], 50, interval '1 minute')`)[0]!.n).toBe(9);
    await h!.svc`UPDATE jobs SET state = 'QUEUED', locked_by = NULL, locked_until = NULL, attempts = 0 WHERE state = 'RUNNING'`;
  });
  it('prioritises chosen photographs, or everything imported recently, and can put it all back', async (ctx) => {
    need(ctx);
    expect((await A.json('POST', '/api/ai/queue/prioritize', { photoIds: [photos[1]!.photoId, photos[2]!.photoId] })).body.updated).toBe(4);
    const order = await h!.svc<{ kind: string; versionId: string }[]>`SELECT kind, payload->>'versionId' AS "versionId" FROM jobs WHERE user_id = ${aId} AND state='QUEUED' AND priority > 0`;
    expect(new Set(order.map((o) => o.versionId))).toEqual(new Set([photos[1]!.versionId, photos[2]!.versionId]));
    expect((await A.json('GET', '/api/ai/queue')).body.prioritised).toBe(4);
    expect((await A.json('POST', '/api/ai/queue/prioritize', { reset: true })).body.updated).toBe(4);
    expect((await A.json('POST', '/api/ai/queue/prioritize', { importedWithinHours: 24 })).body.updated).toBe(8);
    expect((await A.json('POST', '/api/ai/queue/prioritize', { photoIds: [(await seedOne(h!.svc, bId, {})).photoId] })).body.updated).toBe(0);   // another account's photograph: nothing
    await A.json('POST', '/api/ai/queue/prioritize', { reset: true });
  });
  it('cancel stops what has not started, leaves running jobs and other kinds alone, and never touches another account', async (ctx) => {
    need(ctx); await h!.svc`UPDATE jobs SET state='RUNNING', locked_by='w', locked_until = now() + interval '5 minutes', attempts = 1 WHERE dedupe_key = 'a0'`;
    expect((await A.json('POST', '/api/ai/queue/cancel', {})).body.cancelled).toBe(7);
    const st = Object.fromEntries((await h!.svc<{ k: string; state: string }[]>`SELECT dedupe_key AS k, state FROM jobs WHERE user_id = ${aId}`).map((r) => [r.k, r.state]));
    expect(st.a0).toBe('RUNNING'); expect(st.a1).toBe('CANCELLED'); expect(st.e3).toBe('CANCELLED'); expect(st.d0).toBe('QUEUED');
    expect((await B.json('GET', '/api/ai/queue')).body.waiting).toBe(1);
    expect((await A.json('GET', '/api/ai/queue')).body).toMatchObject({ waiting: 0, running: 1, cancelled: 7 });
  });
  it('history lists attempts with the photograph title, newest first, only for this account', async (ctx) => {
    need(ctx);
    await h!.svc`INSERT INTO job_attempts (user_id, job_id, worker, started_at, finished_at, outcome) SELECT user_id, id, 'w', now() - interval '20 seconds', now() - interval '9 seconds', 'OK' FROM jobs WHERE dedupe_key = 'a1'`;
    await h!.svc`INSERT INTO job_attempts (user_id, job_id, worker, started_at, finished_at, outcome, error) SELECT user_id, id, 'w', now() - interval '5 seconds', now() - interval '4 seconds', 'ERROR', 'model not installed' FROM jobs WHERE dedupe_key = 'a2'`;
    const items = (await A.json('GET', '/api/ai/queue/history')).body.items as Array<{ outcome: string; seconds: number; title: string; error: string | null }>;
    expect(items.map((i) => i.outcome)).toEqual(['ERROR', 'OK']); expect(items[0]).toMatchObject({ title: 'Queue photo 2', error: 'model not installed' }); expect(items[1]).toMatchObject({ title: 'Queue photo 1', seconds: 11 });
    expect((await B.json('GET', '/api/ai/queue/history')).body.items).toEqual([]);
    await h!.svc`UPDATE jobs SET state='SUCCEEDED', finished_at = now() WHERE dedupe_key = 'a1'`;
    const s = (await A.json('GET', '/api/ai/queue')).body; expect(s.secondsPerItem).toBe(11); expect(s.done24h).toBe(1);
  });
});
