import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

/**
 * Every API route is enumerated and called with NO session: the only ones allowed to answer are the explicit public list (sign-in steps, health,
 * and the OAuth return, which is protected by its own signed state). A new route that forgets its auth check fails this test.
 */
const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/totp/setup', 'POST /api/auth/totp/confirm', 'POST /api/auth/totp/verify', 'POST /api/auth/recovery', 'GET /api/instagram/oauth/callback']);
let h: Handles | null; let app: FastifyInstance;
beforeAll(async () => { h = await tryHandles(); if (!h) return; await wipe(h.svc); app = makeApp(h); await app.ready(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });

function routes(a: FastifyInstance): Array<{ method: string; url: string }> {
  const found: Array<{ method: string; url: string }> = []; const tree = a.printRoutes({ commonPrefix: false, includeHooks: false });
  let prefix: string[] = [];
  for (const raw of tree.split('\n')) {
    const m = /^([ │└├─]*)(\S.*?)(?: \(([A-Z, ]+)\))?$/.exec(raw); if (!m) continue;
    const depth = Math.floor(m[1]!.length / 4); prefix = prefix.slice(0, depth); prefix[depth] = m[2]!.replace(/ \(.*$/, '');
    if (m[3]) for (const method of m[3].split(', ')) if (method !== 'HEAD' && method !== 'OPTIONS') found.push({ method, url: prefix.join('') });
  }
  return found;
}

describe('authorization sweep', () => {
  it('finds the API surface', (ctx) => { if (!h) return ctx.skip(); expect(routes(app).filter((r) => r.url.startsWith('/api')).length).toBeGreaterThan(60); });
  it('refuses every non-public /api route without a session (401/403), without side effects', async (ctx) => {
    if (!h) return ctx.skip();
    const open: string[] = [];
    for (const r of routes(app).filter((x) => x.url.startsWith('/api'))) {
      const key = `${r.method} ${r.url}`; if (PUBLIC.has(key)) continue;
      const url = r.url.replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000').replace(/\*/g, 'x');
      const res = await app.inject({ method: r.method as 'GET', url, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      if (res.statusCode !== 401 && res.statusCode !== 403) open.push(`${key} → ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});
