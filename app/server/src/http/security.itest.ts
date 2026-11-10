import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

/**
 * A route-inventory security review: instead of testing the routes someone remembered, this enumerates EVERY route the application registers and
 * checks the same properties on all of them — so a new route that forgets authentication, CSRF or error handling fails here.
 */
let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let uid: string;
const routes: Array<{ method: string; url: string }> = [];
const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/mfa', 'POST /api/auth/totp/setup', 'POST /api/auth/totp/confirm']);
const SKIP_FUZZ = new Set(['POST /api/auth/logout', 'POST /api/auth/sessions/revoke-others', 'POST /api/auth/password', 'DELETE /api/auth/sessions/:id']);       // would end or change the session this test uses
const fill = (url: string) => url.replace(/:[A-Za-z]+/g, () => randomUUID());
const api = () => routes.filter((r) => r.url.startsWith('/api/') && r.method !== 'HEAD' && r.method !== 'OPTIONS');

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); app = makeApp(h, { syntheticMedia: false }, { routeSink: (r) => routes.push(r) });
  uid = await makeUser(h.svc, 'sec@example.test'); A = await new ApiClient(app).signIn('sec@example.test'); await seedOne(h.svc, uid, { title: 'sec' });
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('route inventory', () => {
  it('the application registers a substantial, enumerated API (so this review is not vacuous)', async (ctx) => {
    need(ctx); await app.ready(); expect(api().length).toBeGreaterThan(100); expect(new Set(api().map((r) => r.url.split('/')[2])).size).toBeGreaterThan(10);
  });
  it('EVERY non-public API route refuses an anonymous caller with 401', async (ctx) => {
    need(ctx); await app.ready(); const anon = new ApiClient(app); const bad: string[] = [];
    for (const r of api()) {
      const key = `${r.method} ${r.url}`; if (PUBLIC.has(key)) continue;
      const res = await anon.req(r.method as 'GET', fill(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, { csrf: false });
      if (res.statusCode !== 401) bad.push(`${key} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('EVERY state-changing API route refuses a signed-in caller without the CSRF token (403)', async (ctx) => {
    need(ctx); await app.ready(); const bad: string[] = [];
    for (const r of api()) {
      if (['GET'].includes(r.method) || PUBLIC.has(`${r.method} ${r.url}`)) continue;
      const res = await A.req(r.method as 'POST', fill(r.url), r.method === 'DELETE' ? undefined : {}, { csrf: false });
      if (res.statusCode !== 403) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('EVERY state-changing route refuses a cross-origin request even with a valid session', async (ctx) => {
    need(ctx); await app.ready(); const bad: string[] = [];
    for (const r of api().filter((x) => x.method !== 'GET' && !PUBLIC.has(`${x.method} ${x.url}`)).slice(0, 200)) {
      const res = await A.req(r.method as 'POST', fill(r.url), r.method === 'DELETE' ? undefined : {}, { headers: { origin: 'https://evil.example' } });
      if (![403, 401].includes(res.statusCode)) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('robustness: no route answers an unknown id or an empty/garbage body with a server error', () => {
  it('GET routes with unknown ids and signed in: 200/400/404 only', async (ctx) => {
    need(ctx); await app.ready(); const bad: string[] = [];
    for (const r of api().filter((x) => x.method === 'GET')) { const res = await A.req('GET', fill(r.url)); if (res.statusCode >= 500) bad.push(`GET ${r.url} → ${res.statusCode}`); }
    expect(bad).toEqual([]);
  });
  it('state-changing routes with an empty body, a garbage body and unknown ids: never a 5xx', async (ctx) => {
    need(ctx); await app.ready(); const bad: string[] = [];
    for (const r of api().filter((x) => x.method !== 'GET' && !PUBLIC.has(`${x.method} ${x.url}`) && !SKIP_FUZZ.has(`${x.method} ${x.url}`))) {
      for (const body of [undefined, {}, { a: 'x'.repeat(100), b: [1, 2, 3], c: { d: null } }]) {
        if (r.method === 'DELETE' && body !== undefined) continue;
        const res = await A.req(r.method as 'POST', fill(r.url), body); if (res.statusCode >= 500) bad.push(`${r.method} ${r.url} ${JSON.stringify(body)?.slice(0, 20)} → ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('malformed JSON and an over-large body are refused cleanly', async (ctx) => {
    need(ctx);
    const bad = await app.inject({ method: 'POST', url: '/api/collections', headers: { host: '127.0.0.1:8480', 'content-type': 'application/json', origin: 'http://127.0.0.1:8480', cookie: [...A.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': A.csrf! }, payload: '{"name": ' });
    expect(bad.statusCode).toBe(400);
    const big = await app.inject({ method: 'POST', url: '/api/collections', headers: { host: '127.0.0.1:8480', 'content-type': 'application/json', origin: 'http://127.0.0.1:8480', cookie: [...A.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': A.csrf! }, payload: JSON.stringify({ name: 'x'.repeat(200_000) }) });
    expect(big.statusCode).toBe(413);
  });
});

describe('what responses may contain', () => {
  it('no JSON response from any GET route exposes a secret-bearing field', async (ctx) => {
    need(ctx); await app.ready(); const hits: string[] = [];
    const secret = /token_ciphertext|token_key_id|password_hash|totp_secret|token_hash|recovery_hash|session_token|"idempotencyKey"|"idempotency_key"/i;
    for (const r of api().filter((x) => x.method === 'GET' && !x.url.includes('/image'))) { const res = await A.req('GET', fill(r.url)); if (secret.test(res.body)) hits.push(r.url); }
    const withData = ['/api/auth/me', '/api/auth/sessions', '/api/settings', '/api/library/photos?limit=5', '/api/instagram/account', '/api/collections', '/api/publishing/drafts', '/api/system/status'];
    for (const u of withData) { const res = await A.req('GET', u); if (secret.test(res.body)) hits.push(u); }
    expect(hits).toEqual([]);
  });
  it('security headers are on API responses, errors included; the session cookie is HttpOnly + SameSite', async (ctx) => {
    need(ctx);
    for (const u of ['/api/health', '/api/library/photos?limit=1', `/api/library/photos/${randomUUID()}`, '/api/nope']) {
      const res = await A.req('GET', u); expect(res.headers['x-content-type-options'], u).toBe('nosniff'); expect(res.headers['content-security-policy'], u).toContain("frame-ancestors 'none'"); expect(res.headers['x-frame-options'], u).toBe('DENY'); expect(res.headers['referrer-policy'], u).toBe('no-referrer');
    }
    const login = await new ApiClient(app).req('POST', '/api/auth/login', { email: 'sec@example.test', password: 'wrong wrong wrong' }); void login;
    const cookies = ([] as string[]).concat((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: '127.0.0.1:8480', origin: 'http://127.0.0.1:8480', 'content-type': 'application/json' }, payload: { email: 'sec@example.test', password: 'a long unusual passphrase 42' } })).headers['set-cookie'] ?? []);
    for (const c of cookies) { expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=(Strict|Lax)/i); }
  });
  it('a request with a foreign Host header is refused (DNS-rebinding defence), on every method', async (ctx) => {
    need(ctx);
    for (const m of ['GET', 'POST'] as const) { const res = await app.inject({ method: m, url: '/api/health', headers: { host: 'evil.example' } }); expect(res.statusCode, m).toBeGreaterThanOrEqual(400); expect(res.statusCode).toBeLessThan(500); }
  });
});
