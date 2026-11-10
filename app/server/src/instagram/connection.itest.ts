import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import type { Job } from '../jobs/worker.js';
import { MockInstagramOAuth } from './mock-oauth.js';
import { GraphInstagramProvider, ProviderError } from './provider.js';
import { InstagramConnection, TokenVault, type IgOAuthConfig } from './oauth.js';
import { instagramHandlers } from './sync.js';

/**
 * Connecting an Instagram professional account, keeping its token safe, renewing it, reading its history — all against a SANDBOX on this computer.
 * This proves the application's side of the protocol; it cannot prove what the real Instagram does.
 */
const KEY = Buffer.alloc(32, 5);                                   // the test application's token key (same as makeApp's)
const clock = { t: Date.now() }; const DAY = 86_400_000;
let h: Handles | null; let mock: MockInstagramOAuth; let app: FastifyInstance; let unconfigured: FastifyInstance; let A: ApiClient, U: ApiClient, B: ApiClient; let ua: string, ub: string, ud: string; let cfg: IgOAuthConfig; let media: string;
const REDIRECT = 'https://photos.example.test:8480/api/instagram/oauth/callback';
const dirs: string[] = [];
const walk = async (c: ApiClient) => { const start = (await c.json('POST', '/api/instagram/connect')).body.url as string; return { start, back: await mock.consent(start) }; };
const callback = (c: ApiClient, back: URL, extra = '') => c.req('GET', `/api/instagram/oauth/callback${back.search}${extra}`);

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  mock = new MockInstagramOAuth({ appId: 'test-app', appSecret: 'test-secret', now: () => clock.t }); await mock.start();
  cfg = { appId: 'test-app', appSecret: () => 'test-secret', redirectUri: REDIRECT, authorizeUrl: mock.authorizeUrl, tokenUrl: mock.tokenUrl, graphBase: mock.graphBase, now: () => clock.t };
  await wipe(h.svc); ua = await makeUser(h.svc, 'ig@example.test'); ub = await makeUser(h.svc, 'ig2@example.test'); await makeUser(h.svc, 'ig3@example.test'); ud = await makeUser(h.svc, 'ig4@example.test');
  app = makeApp(h, { instagramOAuth: cfg }); unconfigured = makeApp(h, { instagramOAuth: null });
  A = await new ApiClient(app).signIn('ig@example.test'); B = await new ApiClient(app).signIn('ig2@example.test'); U = await new ApiClient(unconfigured).signIn('ig3@example.test');
  media = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-igc-'))); dirs.push(media);
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await unconfigured.close(); await h.close(); await mock.stop(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('the connection says what is missing instead of pretending', () => {
  it('without a Meta app: not configured, lists exactly what is needed and the eligibility rules, refuses to start, sends nothing', async (ctx) => {
    need(ctx); const s = (await U.json('GET', '/api/instagram/connection')).body;
    expect(s).toMatchObject({ configured: false, mode: 'unconfigured', connected: false, account: null }); expect(s.missing.join(' ')).toMatch(/Meta app ID and secret/); expect(s.missing.join(' ')).toMatch(/approval/);
    expect(s.eligibility.join(' ')).toMatch(/professional Instagram account/); expect(s.eligibility.join(' ')).toMatch(/personal accounts cannot/i); expect(s.eligibility.join(' ')).toMatch(/public HTTPS/);
    const c = await U.json('POST', '/api/instagram/connect'); expect(c.status).toBe(409); expect(c.body.error).toBe('not_configured'); expect(mock.calls).toHaveLength(0);
  });
  it('a real (non-loopback) Instagram endpoint is refused unless live is explicitly approved', () => {
    const conn = (o: Partial<IgOAuthConfig>) => new InstagramConnection({ sql: h!.app, cfg: { appId: 'a', appSecret: () => 's', redirectUri: REDIRECT, ...o }, atRestKey: KEY, stateKey: Buffer.alloc(32, 1) });
    expect(() => conn({}).begin(ua)).toThrow(/disabled until you approve/); expect(conn({}).mode()).toBe('unconfigured'); expect(conn({ live: true }).begin(ua).url).toMatch(/^https:\/\/www\.instagram\.com\/oauth\/authorize\?/); expect(conn({ live: true }).mode()).toBe('live');
    expect(() => new GraphInstagramProvider({ enabled: true, igUserId: '1', token: () => 't', transport: { get: async () => ({ status: 200, headers: {} }) } })).toThrow(/disabled until you approve/);
    expect(() => new GraphInstagramProvider({ enabled: true, igUserId: '1', token: () => 't', transport: { get: async () => ({ status: 200, headers: {} }) }, baseUrl: 'http://graph.instagram.com', live: true })).toThrow(ProviderError);      // live still needs https
  });
});

describe('OAuth connection (sandbox)', () => {
  it('start → Instagram consent → callback: stores a sealed long-lived token, shows who is connected, never returns the token', async (ctx) => {
    need(ctx); const { start, back } = await walk(A);
    const u = new URL(start); expect(u.origin + u.pathname).toBe(mock.authorizeUrl); expect(u.searchParams.get('client_id')).toBe('test-app'); expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT); expect(u.searchParams.get('scope')).toBe('instagram_business_basic'); expect(u.searchParams.get('response_type')).toBe('code'); expect(u.searchParams.get('state')).toBeTruthy();
    expect(back.origin + back.pathname).toBe(REDIRECT);
    const r = await callback(A, back); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe('/publish/history?connection=ok');
    const s = (await A.json('GET', '/api/instagram/connection')).body;
    expect(s).toMatchObject({ configured: true, mode: 'sandbox', connected: true, account: { username: 'sandbox_photographer', type: 'BUSINESS', status: 'CONNECTED', synthetic: false }, warning: null }); expect(s.account.daysLeft).toBeGreaterThanOrEqual(59);
    expect(s.account.scopes).toEqual(['instagram_business_basic', 'instagram_business_content_publish']);
    expect(JSON.stringify(s)).not.toMatch(/long_|short_|test-secret/);                                                          // no token, no app secret in any answer
    const [row] = await h!.svc<{ token_ciphertext: Buffer; token_key_id: string }[]>`SELECT token_ciphertext, token_key_id FROM social_accounts WHERE user_id = ${ua}`;
    expect(row!.token_ciphertext.toString('latin1')).not.toContain('long_'); expect(row!.token_key_id).toBe('v1');              // sealed, not plain
    await expect(h!.app`SELECT token_ciphertext FROM social_accounts`).rejects.toThrow(/permission denied/);                   // the API role cannot even read the column
    const vault = new TokenVault({ sql: h!.svc, atRestKey: KEY, cfg }); const id = (await h!.svc<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${ua}`)[0]!.id;
    const t = await vault.read(id, ua); expect(t!.token).toMatch(/^long_/); expect(t!.igUserId).toBe('17841400000000000'); expect(await vault.read(id, ub)).toBeNull();     // another user's id cannot read it
    expect((await B.json('GET', '/api/instagram/connection')).body.account).toBeNull();                                                  // and the other person does not see it
  });
  it('rejects a replayed, forged, foreign, expired or cancelled callback; a reused code fails at Instagram; a personal account is refused and nothing is stored', async (ctx) => {
    need(ctx); const before = mock.calls.length;
    const first = await walk(A); expect((await callback(A, first.back)).headers.location).toBe('/publish/history?connection=ok');
    expect((await callback(A, first.back)).headers.location).toBe('/publish/history?connection=error&reason=bad_state');                    // replay of the same state
    const forged = await walk(A); const bad = new URL(forged.back); bad.searchParams.set('state', bad.searchParams.get('state')!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))); expect((await callback(A, bad)).headers.location).toMatch(/reason=bad_state/);
    const foreign = await walk(A); expect((await callback(B, foreign.back)).headers.location).toMatch(/reason=bad_state/);                // started by A, presented by B
    const late = await walk(A); clock.t += 11 * 60_000; expect((await callback(A, late.back)).headers.location).toMatch(/reason=bad_state/); clock.t -= 11 * 60_000;                                // older than ten minutes
    const denied = await walk(A); const d = new URL(denied.back); d.searchParams.delete('code'); d.searchParams.set('error', 'access_denied'); expect((await callback(A, d)).headers.location).toMatch(/reason=denied/);
    const reuse = await walk(A); const code = new URL(reuse.back).searchParams.get('code')!; mock.codes.get(code)!.used = true; expect((await callback(A, reuse.back)).headers.location).toMatch(/reason=exchange_failed/);
    expect(mock.calls.length).toBeGreaterThan(before);
    const personal = new MockInstagramOAuth({ appId: 'test-app', appSecret: 'test-secret', accountType: 'PERSONAL', userId: '555', now: () => clock.t }); await personal.start();
    const pc = makeApp(h!, { instagramOAuth: { ...cfg, authorizeUrl: personal.authorizeUrl, tokenUrl: personal.tokenUrl, graphBase: personal.graphBase } }); const PC = await new ApiClient(pc).signIn('ig4@example.test');
    const start = (await PC.json('POST', '/api/instagram/connect')).body.url as string; const back = await personal.consent(start);
    expect((await PC.req('GET', `/api/instagram/oauth/callback${back.search}`)).headers.location).toMatch(/reason=ineligible/); expect(await h!.svc`SELECT 1 FROM social_accounts WHERE user_id = ${ud}`).toHaveLength(0);
    await pc.close(); await personal.stop();
  });
});

describe('token lifetime, renewal and revocation', () => {
  it('is renewed before it expires (only then), the new token is sealed, and a failure to renew for network reasons changes nothing', async (ctx) => {
    need(ctx); const vault = new TokenVault({ sql: h!.svc, atRestKey: KEY, cfg }); const id = (await h!.svc<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${ua}`)[0]!.id;
    const t0 = (await vault.read(id, ua))!;
    expect(await vault.refreshDue(20, () => clock.t)).toEqual({ refreshed: 0, expired: 0, skipped: 0 });                         // 60 days left: nothing due
    clock.t += 30 * DAY; expect((await A.json('GET', '/api/instagram/connection')).body.account.daysLeft).toBeLessThanOrEqual(30);
    expect(await vault.refreshDue(20, () => clock.t)).toEqual({ refreshed: 0, expired: 0, skipped: 0 });                         // 30 days left: still not due
    clock.t += 16 * DAY;                                                                                                          // 14 days left: due
    expect((await A.json('GET', '/api/instagram/connection')).body.warning).toMatch(/expires in 14 days/);
    const r = await vault.refreshDue(20, () => clock.t); expect(r).toEqual({ refreshed: 1, expired: 0, skipped: 0 });
    const t1 = (await vault.read(id, ua))!; expect(t1.token).not.toBe(t0.token); expect(t1.expiresAt!.getTime()).toBeGreaterThan(clock.t + 59 * DAY);
    expect((await A.json('GET', '/api/instagram/connection')).body.warning).toBeNull();
    const down = new TokenVault({ sql: h!.svc, atRestKey: KEY, cfg: { ...cfg, graphBase: 'http://127.0.0.1:9/v1' } }); clock.t += 50 * DAY;
    expect(await down.refreshDue(20, () => clock.t)).toEqual({ refreshed: 0, expired: 0, skipped: 1 }); expect((await vault.read(id, ua))!.token).toBe(t1.token);        // unreachable: left alone
    clock.t -= 50 * DAY;
  });
  it('a token Instagram revokes is marked expired with a clear message; syncing then refuses instead of retrying forever', async (ctx) => {
    need(ctx); const vault = new TokenVault({ sql: h!.svc, atRestKey: KEY, cfg }); const id = (await h!.svc<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${ua}`)[0]!.id;
    mock.revokeAll(); clock.t += 50 * DAY; expect(await vault.refreshDue(20, () => clock.t)).toEqual({ refreshed: 0, expired: 1, skipped: 0 }); clock.t -= 50 * DAY;
    const s = (await A.json('GET', '/api/instagram/connection')).body; expect(s).toMatchObject({ connected: false, account: { status: 'EXPIRED' } }); expect(s.warning).toMatch(/expired or was revoked\. Connect again/); expect(s.account.lastError).toMatch(/connect the account again/);
    const job = { id: 'j', user_id: ua, kind: 'ig.sync', payload: { accountId: id }, attempts: 1, max_attempts: 3 } as Job;
    await expect(instagramHandlers(h!.svc, media, null, { vault, cfg })['ig.sync']!(job)).rejects.toThrow(/not connected \(or its token expired\)/);
  });
  it('disconnecting removes the sealed token and the connection', async (ctx) => {
    need(ctx); const { back } = await walk(A); await callback(A, back);
    expect((await A.json('POST', '/api/instagram/disconnect')).body).toEqual({ disconnected: true });
    expect(await h!.svc`SELECT 1 FROM social_accounts WHERE user_id = ${ua} AND token_ciphertext IS NOT NULL`).toHaveLength(0); expect((await A.json('GET', '/api/instagram/connection')).body).toMatchObject({ connected: false, account: { status: 'DISCONNECTED' } });
  });
});

describe('reading the account history through the official API (sandbox)', () => {
  it('downloads every post page by page with the sealed token, stores the posts and their images, and uses the token only against the API host', async (ctx) => {
    need(ctx); mock.posts = Array.from({ length: 30 }, (_, i) => ({ id: `p${String(i).padStart(3, '0')}`, caption: `Sandbox post ${i} #sandbox`, timestamp: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(), colour: { r: 10 * (i % 20), g: 120, b: 200 - 5 * i }, width: 640 + i, height: 640 }));
    const { back } = await walk(A); await callback(A, back); const id = (await h!.svc<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${ua}`)[0]!.id;
    const vault = new TokenVault({ sql: h!.svc, atRestKey: KEY, cfg }); mock.calls.length = 0;
    await instagramHandlers(h!.svc, media, null, { vault, cfg })['ig.sync']!({ id: 'j', user_id: ua, kind: 'ig.sync', payload: { accountId: id }, attempts: 1, max_attempts: 3 } as Job);
    expect(await h!.svc`SELECT 1 FROM social_posts WHERE user_id = ${ua}`).toHaveLength(30); expect(await h!.svc`SELECT 1 FROM social_post_media WHERE user_id = ${ua}`).toHaveLength(30);
    expect(mock.calls.filter((c) => c.path === `/v1/17841400000000000/media`)).toHaveLength(2);                                  // two pages of up to 25
    expect(fs.readdirSync(media).length).toBeGreaterThan(0);
    const again = mock.calls.length; await instagramHandlers(h!.svc, media, null, { vault, cfg })['ig.sync']!({ id: 'j', user_id: ua, kind: 'ig.sync', payload: { accountId: id }, attempts: 1, max_attempts: 3 } as Job);
    expect(await h!.svc`SELECT 1 FROM social_posts WHERE user_id = ${ua}`).toHaveLength(30); expect(mock.calls.length).toBeGreaterThan(again);                    // a second sync adds nothing new
  }, 60_000);
  it('without a Meta app configuration the sync job refuses clearly', async (ctx) => {
    need(ctx); const id = (await h!.svc<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${ua}`)[0]!.id;
    await expect(instagramHandlers(h!.svc, media, null, undefined)['ig.sync']!({ id: 'j', user_id: ua, kind: 'ig.sync', payload: { accountId: id }, attempts: 1, max_attempts: 3 } as Job)).rejects.toThrow(/needs a Meta app and your approval/);
  });
});
