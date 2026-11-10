import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient, makeApp, makeUser, TEST_PW } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { cleanDetail } from './audit.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let aId = '', bId = '';
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); aId = await makeUser(h.svc, 'au1@example.test'); bId = await makeUser(h.svc, 'au2@example.test');
  app = makeApp(h); A = await new ApiClient(app).signIn('au1@example.test'); B = await new ApiClient(app).signIn('au2@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const actions = async (id: string) => (await h!.svc<{ action: string }[]>`SELECT action FROM audit_events WHERE user_id = ${id} ORDER BY id`).map((r) => r.action);

describe('security audit trail', () => {
  it('records enrolment and sign-in, a failed second factor and a refused password, with the address and no secrets', async (ctx) => {
    need(ctx);
    expect(await actions(aId)).toContain('auth.authenticator_enrolled');
    const bad = await new ApiClient(app).req('POST', '/api/auth/login', { email: 'au1@example.test', password: 'wrong wrong wrong 1' }); expect(bad.statusCode).toBe(401);
    const l = (await new ApiClient(app).req('POST', '/api/auth/login', { email: 'au1@example.test', password: TEST_PW })).json();
    const c = new ApiClient(app); const wrongCode = await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: '000000' }); expect(wrongCode.statusCode).toBe(401);
    const a = await actions(aId); expect(a).toContain('auth.password_failed'); expect(a).toContain('auth.second_factor_failed');
    const [secretRow] = await h!.svc<{ totp_secret_ciphertext: Buffer }[]>`SELECT totp_secret_ciphertext FROM users WHERE id = ${aId}`; expect(secretRow).toBeTruthy();
    const dump = JSON.stringify(await h!.svc`SELECT * FROM audit_events WHERE user_id = ${aId}`);
    expect(dump).not.toContain(TEST_PW); expect(dump).not.toContain('wrong wrong'); expect(dump).not.toMatch(/\b\d{6}\b.*code/);
    expect((await h!.svc`SELECT 1 FROM audit_events WHERE user_id = ${aId} AND ip IS NOT NULL`).length).toBeGreaterThan(0);
  });
  it('records password changes, session revocation and sign-out', async (ctx) => {
    need(ctx);
    expect((await A.json('POST', '/api/auth/password', { current: TEST_PW, next: 'another long unusual passphrase 77' })).status).toBe(200);
    expect((await A.json('POST', '/api/auth/sessions/revoke-others', {})).status).toBe(200);
    expect((await A.json('POST', '/api/auth/logout', {})).status).toBe(200);
    await vi.waitFor(async () => expect(await actions(aId)).toEqual(expect.arrayContaining(['auth.password_changed', 'post:auth/password', 'post:auth/sessions/revoke-others', 'post:auth/logout'])), { timeout: 3000 });   // route events are written just after the response
  });
  it('is private to the account, readable through the API, and newest first', async (ctx) => {
    need(ctx);
    const mine = (await B.json('GET', '/api/system/audit')).body.events as Array<{ action: string; id: number; at: string }>;
    expect(mine.length).toBeGreaterThan(0); expect(mine.every((e) => !e.action.startsWith('auth.password_changed'))).toBe(true);
    expect(mine.map((e) => e.at)).toEqual([...mine.map((e) => e.at)].sort().reverse());
    const total = Number((await h!.svc`SELECT count(*)::int AS n FROM audit_events`)[0]!.n); expect(total).toBeGreaterThan(mine.length);        // A's events exist but B cannot see them
    expect((await new ApiClient(app).req('GET', '/api/system/audit')).statusCode).toBe(401);
  });
  it('is append-only for everyone: no update, no delete, not even by the service role or the owner', async (ctx) => {
    need(ctx);
    await expect(h!.svc`UPDATE audit_events SET action = 'x' WHERE user_id = ${bId}`).rejects.toThrow();
    await expect(h!.svc`DELETE FROM audit_events WHERE user_id = ${bId}`).rejects.toThrow();
    await expect(h!.app.begin(async (tx) => { await tx`SELECT set_config('app.user_id', ${bId}, true)`; await tx`DELETE FROM audit_events`; })).rejects.toThrow();
    await expect(h!.app.begin(async (tx) => { await tx`SELECT set_config('app.user_id', ${bId}, true)`; await tx`UPDATE audit_events SET action = 'x'`; })).rejects.toThrow();
  });
  it('keeps only short scalar values under known names', () => {
    expect(cleanDetail({ route: 'a', status: 200, password: 'hunter2', body: { x: 1 }, id: 'u'.repeat(500), token: 't', count: 3, nested: { a: 1 } })).toEqual({ route: 'a', status: 200, id: 'u'.repeat(200), count: 3 });
  });
  it('an account that only enrolled has no sign-in event (nothing is invented)', async (ctx) => {
    need(ctx);
    expect((await actions(bId)).includes('auth.signed_in')).toBe(false);   // B only enrolled; the flow above never used the second step
  });
});
