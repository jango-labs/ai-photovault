import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { JobWorker } from './worker.js';

let h: Handles | null; let uid: string;
beforeAll(async () => { h = await tryHandles(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } });
beforeEach(async () => { if (!h) return; await wipe(h.svc); uid = await makeUser(h.svc, 'heavy@example.test'); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const add = async (kind: string, n: number) => { for (let i = 0; i < n; i++) await h!.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${uid}, ${kind}, '{}'::jsonb, ${`${kind}:${i}`})`; };
const count = async (kind: string, state: string) => Number((await h!.svc`SELECT count(*)::int AS n FROM jobs WHERE kind = ${kind} AND state = ${state}`)[0]!.n);

describe('heavy (local AI) work is limited and held under resource pressure', () => {
  it('runs at most heavyConcurrency heavy jobs per round, while light jobs are not limited', async (ctx) => {
    need(ctx); await add('ai.analyze', 4); await add('derive.preview', 3); let maxHeavy = 0, nowHeavy = 0;
    const w = new JobWorker(h!.svc, { 'ai.analyze': async () => { nowHeavy++; maxHeavy = Math.max(maxHeavy, nowHeavy); await new Promise((r) => setTimeout(r, 30)); nowHeavy--; }, 'derive.preview': async () => undefined },
      { heavyKinds: ['ai.analyze'], heavyConcurrency: 1, concurrency: 3 });
    expect(await w.runOnce()).toBe(4);                                   // 3 light + 1 heavy
    expect(await count('derive.preview', 'SUCCEEDED')).toBe(3); expect(await count('ai.analyze', 'SUCCEEDED')).toBe(1); expect(await count('ai.analyze', 'QUEUED')).toBe(3);
    while ((await w.runOnce()) > 0);
    expect(maxHeavy).toBe(1); expect(await count('ai.analyze', 'SUCCEEDED')).toBe(4);
  });
  it('while the Mac is under pressure only light work runs, the hold is reported once, and heavy work resumes by itself', async (ctx) => {
    need(ctx); await add('ai.analyze', 2); await add('derive.preview', 2); let hold: string | null = 'this computer is short of memory'; const seen: Array<string | null> = [];
    const w = new JobWorker(h!.svc, { 'ai.analyze': async () => undefined, 'derive.preview': async () => undefined }, { heavyKinds: ['ai.analyze'], pressure: async () => hold, onPressure: (r) => seen.push(r), concurrency: 4 });
    expect(await w.runOnce()).toBe(2); expect(await w.runOnce()).toBe(0);
    expect(await count('derive.preview', 'SUCCEEDED')).toBe(2); expect(await count('ai.analyze', 'QUEUED')).toBe(2); expect(seen).toEqual(['this computer is short of memory']);
    hold = null; expect(await w.runOnce()).toBe(1); expect(await w.runOnce()).toBe(1); expect(seen).toEqual(['this computer is short of memory', null]); expect(await count('ai.analyze', 'SUCCEEDED')).toBe(2);
  });
  it('a paused queue is not claimed; resuming releases it; other kinds and other accounts are unaffected', async (ctx) => {
    need(ctx); const other = await makeUser(h!.svc, 'heavy2@example.test'); await add('ai.analyze', 2);
    await h!.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${other}, 'ai.analyze', '{}'::jsonb, 'o1')`; await add('derive.preview', 1);
    await h!.svc`INSERT INTO queue_controls (user_id, queue, paused) VALUES (${uid}, 'ai', true)`;
    const w = new JobWorker(h!.svc, { 'ai.analyze': async () => undefined, 'derive.preview': async () => undefined }, { concurrency: 8 });
    expect(await w.runOnce()).toBe(2);                                   // the other account's analysis and this account's preview
    expect(await count('ai.analyze', 'QUEUED')).toBe(2);
    await h!.svc`UPDATE queue_controls SET paused = false WHERE user_id = ${uid}`; expect(await w.runOnce()).toBe(2); expect(await count('ai.analyze', 'QUEUED')).toBe(0);
  });
});
