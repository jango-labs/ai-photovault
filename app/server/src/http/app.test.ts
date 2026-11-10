import type { Sql } from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuthService } from '../auth/service.js';
import { buildApp } from './app.js';

// A stand-in database and auth service: these tests are about the HTTP hardening layer, not the data layer.
const sql = (async () => [{ ok: 1 }]) as unknown as Sql;
const auth = { resolve: async () => null } as unknown as AuthService;
const config = { logLevel: 'silent', allowedHosts: ['127.0.0.1', 'localhost', 'photos.example.test'], cookieSecure: 'auto' as const, webDir: null };
const app = buildApp({ config, sql, auth, sessionSecret: Buffer.alloc(32, 1) });
afterAll(() => app.close());
const H = { host: '127.0.0.1:8480' };

describe('HTTP hardening', () => {
  it('health reports ok and sends hardening headers; API responses are never cached', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'photovault-api', version: '0.5.0', database: 'ok' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'"); expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff'); expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY'); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['strict-transport-security']).toBeUndefined();         // only over HTTPS
  });
  it('sends HSTS when the request arrived over HTTPS via the local proxy', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'photos.example.test', 'x-forwarded-proto': 'https' }, remoteAddress: '127.0.0.1' });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });
  it('ignores X-Forwarded-* from anything but the local proxy (clients cannot forge their address or claim HTTPS)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:8480', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '10.0.0.5' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
  it('behind a local reverse proxy the browser-facing host (X-Forwarded-Host) is what is checked — and only from the proxy', async () => {
    const post = (remoteAddress: string, forwarded: string, origin: string) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress,
      headers: { host: '127.0.0.1:8480', 'x-forwarded-host': forwarded, 'x-forwarded-proto': 'https', origin, 'content-type': 'application/json' }, payload: { email: 'a@b.co', password: 'x' } });
    expect((await post('127.0.0.1', 'photos.example.test:8480', 'https://photos.example.test:8480')).statusCode).not.toBe(403);   // proxy says the browser used the tailnet name: same-origin
    expect((await post('127.0.0.1', 'photos.example.test:8480', 'https://evil.example.com')).statusCode).toBe(403);
    expect((await post('127.0.0.1', 'evil.example.com', 'https://evil.example.com')).statusCode).toBe(421);                              // not an allowed host name
    expect((await post('10.0.0.5', 'photos.example.test:8480', 'https://photos.example.test:8480')).statusCode).toBe(403);           // forged by a non-proxy client: ignored, Host stays 127.0.0.1:8480
  });
  it('rejects unknown Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.example.com', 'evil.example.com:8480', '192.168.1.5:8480', '198.51.100.7:8480']) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(421);
    }
  });
  it('degrades honestly when the database is down', async () => {
    const broken = buildApp({ config, sql: (async () => { throw new Error('down'); }) as unknown as Sql, auth, sessionSecret: Buffer.alloc(32, 1) });
    const res = await broken.inject({ method: 'GET', url: '/api/health', headers: H });
    expect(res.statusCode).toBe(503); expect(res.json()).toMatchObject({ status: 'degraded', database: 'error' }); expect(JSON.stringify(res.json())).not.toContain('down');
    await broken.close();
  });
  it('protected routes answer 401 without a session', async () => {
    for (const [method, url] of [['GET', '/api/auth/me'], ['GET', '/api/settings'], ['GET', '/api/auth/sessions'], ['GET', '/api/system/status']] as const) {
      const res = await app.inject({ method, url, headers: H });
      expect(res.statusCode, url).toBe(401); expect(res.json().error).toBe('unauthenticated');
    }
  });
  it('state-changing requests must be same-origin (Origin must equal Host, including the port)', async () => {
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...H, 'content-type': 'application/json', ...headers }, payload: { email: 'a@b.co', password: 'x' } });
    expect((await post({ origin: 'https://evil.example.com' })).statusCode).toBe(403);
    expect((await post({ origin: 'http://127.0.0.1:3000' })).statusCode).toBe(403);      // another local app (Prompt Library port) is cross-origin
    expect((await post({ origin: 'http://localhost:8480' })).statusCode).toBe(403);      // different host name
    expect((await post({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({})).statusCode).toBe(403);                                        // no Origin and no fetch metadata
    const ok = await post({ origin: 'http://127.0.0.1:8480' });
    expect(ok.statusCode).not.toBe(403);
  });
  it('rejects oversize bodies, non-JSON bodies and malformed input', async () => {
    const o = { ...H, origin: 'http://127.0.0.1:8480' };
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...o, 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(70_000) }) })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...o, 'content-type': 'text/plain' }, payload: 'email=a' })).statusCode).toBe(415);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...o, 'content-type': 'application/json' }, payload: { email: 'not-an-email', password: 'x' } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error).toBe('invalid_request');
  });
  it('unknown API routes return JSON 404, not HTML or stack traces', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: H });
    expect(res.statusCode).toBe(404); expect(res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });
});
