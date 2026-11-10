import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { JobWorker } from './worker.js';

let h: Handles | null; let uid: string;
beforeAll(async () => { h = await tryHandles(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } });
beforeEach(async () => { if (!h) return; await wipe(h.svc); uid = await makeUser(h.svc, 'gate@example.test'); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const add = async (n: number) => { for (let i = 0; i < n; i++) await h!.svc`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${uid}, 'test.echo', ${h!.svc.json({ i })}, ${`t${i}`})`; };
const states = async () => (await h!.svc<{ state: string; attempts: number; last_error: string | null }[]>`SELECT state, attempts, last_error FROM jobs ORDER BY dedupe_key`);

describe('a worker stops safely when its storage drive is unavailable', () => {
  it('claims nothing while the gate gives a reason, reports the pause once, and resumes when the drive returns', async (ctx) => {
    need(ctx); await add(3); let reason: string | null = 'the drive is not connected'; const seen: Array<string | null> = []; const done: number[] = [];
    const w = new JobWorker(h!.svc, { 'test.echo': async (j) => { done.push((j.payload as { i: number }).i); } }, { gate: async () => reason, onPause: (r) => seen.push(r), concurrency: 3, backoffBaseSeconds: 0 });
    expect(await w.runOnce()).toBe(0); expect(await w.runOnce()).toBe(0);
    expect(await states()).toEqual([0, 1, 2].map(() => ({ state: 'QUEUED', attempts: 0, last_error: null })));      // nothing attempted, nothing failed, nothing used up
    expect(seen).toEqual(['the drive is not connected']); expect(w.pausedReason).toBe('the drive is not connected'); expect(done).toEqual([]);
    reason = null; expect(await w.runOnce()).toBe(3); expect(seen).toEqual(['the drive is not connected', null]); expect(done.sort()).toEqual([0, 1, 2]);
    expect((await states()).every((s) => s.state === 'SUCCEEDED')).toBe(true);
  });
  it('a job that fails because the drive vanished under it is put back for free (no attempt consumed); the same failure with the drive present is a normal retry', async (ctx) => {
    need(ctx); await add(1); let away = false; let calls = 0;
    const w = new JobWorker(h!.svc, { 'test.echo': async () => { calls++; if (calls === 1) { away = true; throw new Error('EIO: i/o error, write'); } if (calls === 2) throw new Error('bad pixel data'); } }, { gate: async () => (away ? 'the drive is not connected' : null), concurrency: 1, backoffBaseSeconds: 0 });
    expect(await w.runOnce()).toBe(1);
    expect(await states()).toEqual([{ state: 'QUEUED', attempts: 0, last_error: 'storage unavailable: the drive is not connected' }]);
    await h!.svc`UPDATE jobs SET run_after = now()`; expect(await w.runOnce()).toBe(0);                                  // still away: not claimed
    away = false; expect(await w.runOnce()).toBe(1);                                                                   // back: runs, and now a genuine error counts
    expect(await states()).toEqual([{ state: 'QUEUED', attempts: 1, last_error: 'bad pixel data' }]);
    await h!.svc`UPDATE jobs SET run_after = now()`; expect(await w.runOnce()).toBe(1); expect((await states())[0]).toMatchObject({ state: 'SUCCEEDED' });
  });
  it('without a gate nothing changes', async (ctx) => {
    need(ctx); await add(2); const w = new JobWorker(h!.svc, { 'test.echo': async () => undefined }, { concurrency: 2 });
    expect(await w.runOnce()).toBe(2); expect(w.pausedReason).toBeNull();
  });
});
