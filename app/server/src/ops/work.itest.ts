import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient;
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); await makeUser(h.svc, 'w1@example.test'); await makeUser(h.svc, 'w2@example.test');
  app = makeApp(h); A = await new ApiClient(app).signIn('w1@example.test'); B = await new ApiClient(app).signIn('w2@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });

describe('work status for the System page', () => {
  it('requires sign-in', async (ctx) => {
    if (!h) return ctx.skip();
    expect((await new ApiClient(app).req('GET', '/api/system/work')).statusCode).toBe(401);
  });
  it('is empty and healthy for a new library, and reports only the caller\'s own jobs', async (ctx) => {
    if (!h) return ctx.skip();
    const [u] = await h.svc`SELECT id FROM users WHERE email = 'w1@example.test'`;
    await h.svc`INSERT INTO jobs (user_id, kind, state, last_error, finished_at, attempts) VALUES (${u!.id}, 'ai.analyze', 'DEAD', 'model not installed', now(), 5)`;
    const a = (await A.json('GET', '/api/system/work')).body; const b = (await B.json('GET', '/api/system/work')).body;
    expect(a.queues[0]).toMatchObject({ kind: 'ai.analyze', dead: 1 });
    expect(a.failures[0].error).toContain('model not installed');
    expect(a.problems.join(' ')).toContain('gave up');
    expect(b.queues).toEqual([]); expect(b.failures).toEqual([]); expect(b.problems).toEqual([]);
    expect(b.imports.last).toBeNull(); expect(b.instagram).toBeNull();
  });
  it('AI analysis paused with work waiting is called out, and a stale worker heartbeat is reported', async (ctx) => {
    if (!h) return ctx.skip();
    const [u] = await h.svc`SELECT id FROM users WHERE email = 'w2@example.test'`;
    await h.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${u!.id}, 'ai.analyze', '{}'::jsonb, 'w2-a')`;
    await h.svc`INSERT INTO queue_controls (user_id, queue, paused) VALUES (${u!.id}, 'ai', true)`;
    await h.svc`INSERT INTO service_heartbeats (service, instance, pid, version, at) VALUES ('worker', 'x', 1, '0.5.0', now() - interval '1 hour') ON CONFLICT (service) DO UPDATE SET at = excluded.at`;
    const b = (await B.json('GET', '/api/system/work')).body;
    expect(b.problems.join(' | ')).toContain('AI analysis is paused with 1 job waiting'); expect(b.problems.join(' | ')).toMatch(/background worker is (late reporting|not running)/);
  });
});
