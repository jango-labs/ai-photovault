import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../auth/crypto.js';
import { hashPassword } from '../auth/password.js';
import { AuthService } from '../auth/service.js';
import { totpAt } from '../auth/totp.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { buildApp } from './app.js';

const KEY = Buffer.alloc(32, 5), SECRET = Buffer.alloc(32, 6);
const HOST = '127.0.0.1:8480';
const PW = 'a long unusual passphrase 42';
let h: Handles | null; let app: FastifyInstance; let nowMs = Date.now();

beforeAll(async () => {
  h = await tryHandles();
  if (!h) return;
  const auth = new AuthService({ sql: h.app, sessionSecret: SECRET, atRestKey: KEY, now: () => nowMs });
  app = buildApp({ config: { logLevel: 'silent', allowedHosts: ['127.0.0.1', 'localhost'], cookieSecure: 'auto', webDir: null }, sql: h.app, auth, sessionSecret: SECRET, now: () => nowMs });
});
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
beforeEach(async () => { if (h) { await wipe(h.svc); nowMs = Date.now(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); return h!; };

async function createUser(email: string, pw = PW): Promise<string> {
  const [u] = await h!.svc<{ id: string }[]>`INSERT INTO users (email, password_hash) VALUES (${email}, ${await hashPassword(pw)}) RETURNING id`;
  return u!.id;
}

/** A browser stand-in: cookie jar + CSRF header handling. */
let ipCounter = 0;
const nextIp = () => { ipCounter++; return `10.50.${ipCounter >> 8}.${ipCounter & 255}`; };
class Client {
  jar = new Map<string, string>(); csrf: string | undefined; confirmCookies: string[] = []; last: Awaited<ReturnType<FastifyInstance['inject']>> | undefined;
  constructor(public ip = nextIp(), private https = false) {}
  async req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, o: { csrf?: string | false; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { host: HOST, 'user-agent': 'vitest', ...o.headers };
    if (method !== 'GET') { headers.origin = `http://${HOST}`; if (payload !== undefined) headers['content-type'] = 'application/json'; }
    if (this.https) { headers['x-forwarded-proto'] = 'https'; headers['x-forwarded-for'] = this.ip; }   // arrives via a local reverse proxy
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    const res = await app.inject({ method, url, headers, payload: payload as object, remoteAddress: this.https ? '127.0.0.1' : this.ip });
    for (const c of [].concat((res.headers['set-cookie'] ?? []) as never) as string[]) {
      const [kv, ...attrs] = c.split('; '); const [k, v] = kv!.split('=');
      if (!v || attrs.some((a) => /^Max-Age=0$/i.test(a)) || /Expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k!); else this.jar.set(k!, v);
    }
    this.last = res;
    return res;
  }
  async me() { const r = await this.req('GET', '/api/auth/me'); if (r.statusCode === 200) this.csrf = r.json().csrfToken; return r; }
  async enrol(email: string, pw = PW) {
    const l = (await this.req('POST', '/api/auth/login', { email, password: pw })).json();
    expect(l.step).toBe('enroll');
    const s = (await this.req('POST', '/api/auth/totp/setup', { challenge: l.challenge })).json();
    const c = await this.req('POST', '/api/auth/totp/confirm', { challenge: l.challenge, code: totpAt(s.secret, nowMs) });
    expect(c.statusCode).toBe(200);
    this.confirmCookies = [].concat(c.headers['set-cookie'] as never) as string[];
    await this.me();
    return { secret: s.secret as string, recoveryCodes: c.json().recoveryCodes as string[] };
  }
  async signIn(email: string, secret: string, pw = PW) {
    const l = (await this.req('POST', '/api/auth/login', { email, password: pw })).json();
    const r = await this.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt(secret, nowMs) });
    if (r.statusCode === 200) await this.me();
    return r;
  }
}

describe('sign-in', () => {
  it('unknown email and wrong password are indistinguishable', async (ctx) => {
    need(ctx); await createUser('real@example.test');
    const c = new Client();
    const a = await c.req('POST', '/api/auth/login', { email: 'nobody@example.test', password: 'whatever-whatever' });
    const b = await c.req('POST', '/api/auth/login', { email: 'real@example.test', password: 'wrong-wrong-wrong' });
    expect(a.statusCode).toBe(401); expect(b.statusCode).toBe(401); expect(a.body).toBe(b.body);
  });

  it('a first sign-in must enrol an authenticator: QR + secret, wrong code refused, session only after a valid code', async (ctx) => {
    need(ctx); await createUser('new@example.test');
    const c = new Client();
    const l = (await c.req('POST', '/api/auth/login', { email: 'NEW@Example.test ', password: PW })).json();   // email is case/space-insensitive
    expect(l.step).toBe('enroll'); expect(c.jar.size).toBe(0);                                                  // password alone gives no session
    const s = (await c.req('POST', '/api/auth/totp/setup', { challenge: l.challenge })).json();
    expect(s.secret).toMatch(/^[A-Z2-7]{32}$/); expect(s.qr).toMatch(/^data:image\/svg\+xml;base64,/); expect(s.uri).toContain('otpauth://totp/');
    const bad = await c.req('POST', '/api/auth/totp/confirm', { challenge: l.challenge, code: '000000' });
    expect(bad.statusCode).toBe(401); expect(c.jar.size).toBe(0);
    const ok = await c.req('POST', '/api/auth/totp/confirm', { challenge: l.challenge, code: totpAt(s.secret, nowMs) });
    expect(ok.statusCode).toBe(200); expect(c.jar.has('jp_session')).toBe(true);
    const codes: string[] = ok.json().recoveryCodes;
    expect(codes).toHaveLength(10); expect(new Set(codes).size).toBe(10); for (const x of codes) expect(x).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect((await c.me()).statusCode).toBe(200);
  });

  it('the session cookie is HttpOnly, SameSite=Lax, path /, and Secure only over HTTPS', async (ctx) => {
    need(ctx); await createUser('c@example.test'); await createUser('d@example.test');
    const http = new Client(); await http.enrol('c@example.test');
    const cookieHttp = http.confirmCookies;
    const sHttp = (await (async () => { const x = new Client(); const l = (await x.req('POST', '/api/auth/login', { email: 'c@example.test', password: PW })).json(); nowMs += 30_000; const r = await x.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt((await getSecret('c@example.test')), nowMs) }); return r.headers['set-cookie'] as string; })());
    for (const c of [...cookieHttp.filter((x) => x.startsWith('jp_session')), sHttp]) { expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Lax/i); expect(c).toMatch(/Path=\//); expect(c).toMatch(/Max-Age=2592000/); expect(c).not.toMatch(/Secure/i); }
    const https = new Client('10.1.0.9', true); await https.enrol('d@example.test');
    const sc = https.confirmCookies.find((x) => x.startsWith('__Host-jp_session'))!;
    expect(sc).toMatch(/; Secure/i); expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/Path=\//); expect(sc).not.toMatch(/Domain=/i);   // the __Host- prefix rules
    expect(https.confirmCookies.some((x) => x.startsWith('jp_session'))).toBe(false);
  });

  it('cookie isolation: over HTTPS a plain jp_session planted by a sibling app is ignored, and the plain cookie is never accepted as the secure one', async (ctx) => {
    need(ctx); await createUser('iso@example.test');
    const c = new Client(undefined, true); await c.enrol('iso@example.test');
    const real = c.jar.get('__Host-jp_session')!;
    const planted = new Client(nextIp(), true); planted.jar.set('jp_session', real);           // right token, wrong (unprefixed) cookie name
    expect((await planted.req('GET', '/api/auth/me')).statusCode).toBe(401);
    const ok = new Client(nextIp(), true); ok.jar.set('__Host-jp_session', real); ok.jar.set('jp_session', 'attacker-chosen-value');
    expect((await ok.req('GET', '/api/auth/me')).statusCode).toBe(200);                         // a stray cookie with our old name does not break or replace it
    const overHttp = new Client(nextIp(), false); overHttp.jar.set('__Host-jp_session', real);
    expect((await overHttp.req('GET', '/api/auth/me')).statusCode).toBe(401);                   // __Host- is not a cookie plain HTTP uses
  });

  it('stores only hashes and ciphertext: no session token, password or authenticator secret is readable in the database', async (ctx) => {
    const { svc } = need(ctx); await createUser('s@example.test');
    const c = new Client(); const { secret, recoveryCodes } = await c.enrol('s@example.test');
    const token = c.jar.get('jp_session')!;
    const [sess] = await svc`SELECT token_hash FROM sessions`;
    expect(Buffer.from(sess!.token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
    const [u] = await svc`SELECT password_hash, totp_secret_ciphertext, totp_enabled FROM users`;
    expect(u!.password_hash).toMatch(/^\$argon2id\$/); expect(u!.totp_enabled).toBe(true);
    expect(Buffer.from(u!.totp_secret_ciphertext).toString('latin1')).not.toContain(secret);
    const id = (await svc`SELECT id FROM users`)[0]!.id as string;
    expect(open(KEY, Buffer.from(u!.totp_secret_ciphertext), `totp:${id}`)).toBe(secret);
    const rc = await svc`SELECT code_hash FROM recovery_codes`; expect(rc).toHaveLength(10);
    for (const code of recoveryCodes) expect(rc.some((r) => Buffer.from(r.code_hash).equals(createHash('sha256').update(code.replace('-', '')).digest()))).toBe(true);
    const dump = JSON.stringify(await svc`SELECT * FROM users`) + JSON.stringify(await svc`SELECT * FROM sessions`) + JSON.stringify(await svc`SELECT * FROM login_attempts`);
    expect(dump).not.toContain(token); expect(dump).not.toContain(PW);
  });

  it('a returning user needs a valid authenticator code; the same code cannot be reused (replay)', async (ctx) => {
    need(ctx); await createUser('r@example.test');
    const first = new Client(); const { secret } = await first.enrol('r@example.test');
    const c = new Client('10.1.0.2');
    const l = (await c.req('POST', '/api/auth/login', { email: 'r@example.test', password: PW })).json(); expect(l.step).toBe('mfa');
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt(secret, nowMs) })).statusCode).toBe(401);   // same step as enrolment: replay
    nowMs += 30_000;
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt(secret, nowMs) })).statusCode).toBe(200);
    const c2 = new Client('10.1.0.3'); const l2 = (await c2.req('POST', '/api/auth/login', { email: 'r@example.test', password: PW })).json();
    expect((await c2.req('POST', '/api/auth/mfa', { challenge: l2.challenge, code: totpAt(secret, nowMs) })).statusCode).toBe(401);     // used a moment ago
    nowMs += 30_000;
    expect((await c2.req('POST', '/api/auth/mfa', { challenge: l2.challenge, code: totpAt(secret, nowMs) })).statusCode).toBe(200);
  });

  it('recovery codes work exactly once', async (ctx) => {
    need(ctx); await createUser('rc@example.test');
    const { recoveryCodes } = await new Client().enrol('rc@example.test');
    const c = new Client('10.1.0.4'); const l = (await c.req('POST', '/api/auth/login', { email: 'rc@example.test', password: PW })).json();
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: recoveryCodes[0]!.toUpperCase() })).statusCode).toBe(200);
    const c2 = new Client('10.1.0.5'); const l2 = (await c2.req('POST', '/api/auth/login', { email: 'rc@example.test', password: PW })).json();
    expect((await c2.req('POST', '/api/auth/mfa', { challenge: l2.challenge, code: recoveryCodes[0]! })).statusCode).toBe(401);
    expect((await c2.req('POST', '/api/auth/mfa', { challenge: l2.challenge, code: recoveryCodes[1]! })).statusCode).toBe(200);
  });

  it('challenges are single-purpose, expire, and cannot be forged', async (ctx) => {
    need(ctx); await createUser('ch@example.test'); const { secret } = await new Client().enrol('ch@example.test');
    const c = new Client('10.1.0.6'); const l = (await c.req('POST', '/api/auth/login', { email: 'ch@example.test', password: PW })).json();
    expect((await c.req('POST', '/api/auth/totp/setup', { challenge: l.challenge })).statusCode).toBe(401);   // an 'mfa' challenge cannot restart enrolment
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge.replace(/.$/, 'A'), code: totpAt(secret, nowMs) })).statusCode).toBe(401);
    nowMs += 6 * 60_000;
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt(secret, nowMs) })).statusCode).toBe(401);   // expired
  });

  it('five failed attempts lock the account for 15 minutes — even a correct code is then refused — and it recovers', async (ctx) => {
    const { svc } = need(ctx); await createUser('lock@example.test'); const { secret } = await new Client().enrol('lock@example.test');
    const c = new Client('10.1.0.7'); const l = (await c.req('POST', '/api/auth/login', { email: 'lock@example.test', password: PW })).json();
    for (let i = 0; i < 5; i++) expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: '000000' })).statusCode).toBe(401);
    nowMs += 30_000;
    const locked = await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt(secret, nowMs) });
    expect(locked.statusCode).toBe(429); expect(locked.headers['retry-after']).toBe('900'); expect(locked.json().error).toBe('locked');
    const other = new Client('10.1.0.8');      // password step is locked for that account from any address
    expect((await other.req('POST', '/api/auth/login', { email: 'lock@example.test', password: PW })).statusCode).toBe(429);
    await svc`UPDATE login_attempts SET at = now() - interval '20 minutes'`;
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: totpAt(secret, nowMs) })).statusCode).toBe(200);
  });

  it('repeated failures from one address lock that address, not others', async (ctx) => {
    need(ctx); await createUser('ip@example.test');
    const bad = new Client('10.9.9.9');
    for (let i = 0; i < 5; i++) await bad.req('POST', '/api/auth/login', { email: `ghost${i}@example.test`, password: 'x'.repeat(12) });
    expect((await bad.req('POST', '/api/auth/login', { email: 'ip@example.test', password: PW })).statusCode).toBe(429);
    expect((await new Client('10.9.9.10').req('POST', '/api/auth/login', { email: 'ip@example.test', password: PW })).statusCode).toBe(200);
  });

  it('a disabled account cannot sign in and its existing session stops working', async (ctx) => {
    const { svc } = need(ctx); await createUser('dis@example.test'); const c = new Client(); await c.enrol('dis@example.test');
    await svc`UPDATE users SET disabled_at = now()`;
    expect((await c.me()).statusCode).toBe(401);
    expect((await new Client('10.1.1.1').req('POST', '/api/auth/login', { email: 'dis@example.test', password: PW })).statusCode).toBe(401);
  });

  it('survives hostile input without SQL errors or data loss', async (ctx) => {
    const { svc } = need(ctx); await createUser('inj@example.test');
    const c = new Client('10.2.0.1');
    for (const email of ["x'; DROP TABLE users;--@a.co", "a@b.co' OR '1'='1", '\u0000@a.co']) {
      const r = await c.req('POST', '/api/auth/login', { email, password: "' OR 1=1 --  padding" });
      expect([400, 401]).toContain(r.statusCode);
    }
    const l = (await c.req('POST', '/api/auth/login', { email: 'inj@example.test', password: PW })).json();
    expect((await c.req('POST', '/api/auth/mfa', { challenge: l.challenge, code: "1' OR '1'='1" })).statusCode).toBe(401);
    expect((await svc`SELECT count(*)::int AS n FROM users`)[0]!.n).toBe(1);
  });
});

async function getSecret(email: string): Promise<string> {
  const [u] = await h!.svc`SELECT id, totp_secret_ciphertext FROM users WHERE email = ${email}`;
  return open(KEY, Buffer.from(u!.totp_secret_ciphertext), `totp:${u!.id}`);
}

describe('authenticated session', () => {
  it('me returns the account and a CSRF token — never secrets', async (ctx) => {
    need(ctx); await createUser('me@example.test'); const c = new Client(); await c.enrol('me@example.test');
    const r = await c.req('GET', '/api/auth/me'); const j = r.json();
    expect(j.user).toMatchObject({ email: 'me@example.test', totpEnabled: true }); expect(j.csrfToken).toHaveLength(43);
    expect(j.settings.viewerSurface).toBe('neutral');                         // neutral grey is the default viewer background
    expect(r.body).not.toMatch(/password|secret|ciphertext|hash/i);
  });

  it('state-changing calls need the CSRF token', async (ctx) => {
    need(ctx); await createUser('csrf@example.test'); const c = new Client(); await c.enrol('csrf@example.test');
    expect((await c.req('PATCH', '/api/settings', { viewerSurface: 'teal' }, { csrf: false })).statusCode).toBe(403);
    expect((await c.req('PATCH', '/api/settings', { viewerSurface: 'teal' }, { csrf: 'wrong' })).statusCode).toBe(403);
    expect((await c.req('PATCH', '/api/settings', { viewerSurface: 'teal' })).statusCode).toBe(200);
    const other = new Client('10.3.0.1'); await createUser('csrf2@example.test'); await other.enrol('csrf2@example.test');
    expect((await c.req('PATCH', '/api/settings', { viewerSurface: 'neutral' }, { csrf: other.csrf })).statusCode).toBe(403);   // another session's token
  });

  it('logout revokes the session on the server, not just in the browser', async (ctx) => {
    const { svc } = need(ctx); await createUser('out@example.test'); const c = new Client(); await c.enrol('out@example.test');
    const stolen = c.jar.get('jp_session')!;
    expect((await c.req('POST', '/api/auth/logout', {})).statusCode).toBe(200);
    expect(c.jar.has('jp_session')).toBe(false);
    const thief = new Client('10.4.0.1'); thief.jar.set('jp_session', stolen);
    expect((await thief.req('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await svc`SELECT revoked_at FROM sessions`)[0]!.revoked_at).not.toBeNull();
  });

  it('sessions expire after 14 days idle and at the absolute limit', async (ctx) => {
    const { svc } = need(ctx); await createUser('exp@example.test'); const c = new Client(); await c.enrol('exp@example.test');
    await svc`UPDATE sessions SET last_seen_at = now() - interval '15 days'`;
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(401);
    const c2 = new Client('10.5.0.1'); const { secret } = await (async () => { const s = await getSecret('exp@example.test'); return { secret: s }; })();
    nowMs += 30_000; expect((await c2.signIn('exp@example.test', secret)).statusCode).toBe(200);
    await svc`UPDATE sessions SET expires_at = now() - interval '1 second', created_at = now() - interval '31 days' WHERE revoked_at IS NULL`;
    expect((await c2.req('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('sessions are listed per user; users cannot see or revoke each other\'s sessions', async (ctx) => {
    need(ctx); await createUser('a@example.test'); await createUser('b@example.test');
    const a = new Client('10.6.0.1'), b = new Client('10.6.0.2'); await a.enrol('a@example.test'); await b.enrol('b@example.test');
    const la = (await a.req('GET', '/api/auth/sessions')).json().sessions, lb = (await b.req('GET', '/api/auth/sessions')).json().sessions;
    expect(la).toHaveLength(1); expect(lb).toHaveLength(1); expect(la[0].current).toBe(true); expect(la[0].id).not.toBe(lb[0].id);
    expect(JSON.stringify(la)).not.toContain('token');
    expect((await a.req('DELETE', `/api/auth/sessions/${lb[0].id}`)).statusCode).toBe(404);
    expect((await b.req('GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await a.req('DELETE', '/api/auth/sessions/not-a-uuid')).statusCode).toBe(400);
  });

  it('can sign out other devices; the current one stays signed in', async (ctx) => {
    need(ctx); await createUser('multi@example.test'); const one = new Client('10.7.0.1'); const { secret } = await one.enrol('multi@example.test');
    const two = new Client('10.7.0.2'); nowMs += 30_000; await two.signIn('multi@example.test', secret);
    expect((await one.req('GET', '/api/auth/sessions')).json().sessions).toHaveLength(2);
    expect((await one.req('POST', '/api/auth/sessions/revoke-others', {})).json().revoked).toBe(1);
    expect((await two.req('GET', '/api/auth/me')).statusCode).toBe(401); expect((await one.req('GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('changing the password needs the current one, enforces policy, and signs out other sessions', async (ctx) => {
    need(ctx); await createUser('pw@example.test'); const one = new Client('10.8.0.1'); const { secret } = await one.enrol('pw@example.test');
    const two = new Client('10.8.0.2'); nowMs += 30_000; await two.signIn('pw@example.test', secret);
    expect((await one.req('POST', '/api/auth/password', { current: 'not the password', next: 'another unusual passphrase 7' })).statusCode).toBe(403);
    expect((await one.req('POST', '/api/auth/password', { current: PW, next: 'short' })).statusCode).toBe(400);
    expect((await one.req('POST', '/api/auth/password', { current: PW, next: 'another unusual passphrase 7' })).statusCode).toBe(200);
    expect((await two.req('GET', '/api/auth/me')).statusCode).toBe(401); expect((await one.req('GET', '/api/auth/me')).statusCode).toBe(200);
    const fresh = new Client('10.8.0.3');
    expect((await fresh.req('POST', '/api/auth/login', { email: 'pw@example.test', password: PW })).statusCode).toBe(401);
    expect((await fresh.req('POST', '/api/auth/login', { email: 'pw@example.test', password: 'another unusual passphrase 7' })).statusCode).toBe(200);
  });
});

describe('authorization and the database security model', () => {
  it('settings are per user (row-level security) and validated', async (ctx) => {
    const { svc } = need(ctx); await createUser('s1@example.test'); await createUser('s2@example.test');
    const a = new Client('10.10.0.1'), b = new Client('10.10.0.2'); await a.enrol('s1@example.test'); await b.enrol('s2@example.test');
    expect((await a.req('PATCH', '/api/settings', { viewerSurface: 'teal', thumbSize: 300 })).json()).toMatchObject({ viewerSurface: 'teal', thumbSize: 300 });
    expect((await b.req('GET', '/api/settings')).json()).toMatchObject({ viewerSurface: 'neutral', thumbSize: 240 });
    expect((await a.req('PATCH', '/api/settings', { viewerSurface: 'pink' })).statusCode).toBe(400);
    expect((await a.req('PATCH', '/api/settings', { thumbSize: 5 })).statusCode).toBe(400);
    expect((await a.req('PATCH', '/api/settings', { user_id: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(400);   // unknown keys refused
    expect((await svc`SELECT count(*)::int AS n FROM user_settings`)[0]!.n).toBe(2);
  });

  it('the API database role cannot read credentials or other users\' rows outside the auth functions', async (ctx) => {
    const { app: appRole } = need(ctx); await createUser('x@example.test'); await createUser('y@example.test');
    expect(await appRole`SELECT password_hash FROM users`).toHaveLength(0);                 // no user context => no rows
    await expect(appRole`SELECT * FROM login_attempts`).rejects.toMatchObject({ code: '42501' });
    const rows = await appRole.begin(async (tx) => { await tx`SELECT set_config('app.user_id', (SELECT id::text FROM auth_find_user('x@example.test')), true)`; return tx`SELECT email FROM users`; });
    expect(rows.map((r) => r.email)).toEqual(['x@example.test']);
  });

  it('system status needs a session and exposes no secrets', async (ctx) => {
    need(ctx); await createUser('sys@example.test'); const c = new Client();
    expect((await c.req('GET', '/api/system/status')).statusCode).toBe(401);
    await c.enrol('sys@example.test');
    const r = await c.req('GET', '/api/system/status'); expect(r.json()).toMatchObject({ api: { ok: true }, database: { ok: true } });
    expect(r.body).not.toMatch(/password|secret|token/i);
  });

  it('health is public and reports the database', async (ctx) => {
    need(ctx); expect((await new Client().req('GET', '/api/health')).json()).toMatchObject({ status: 'ok', database: 'ok' });
  });
});
