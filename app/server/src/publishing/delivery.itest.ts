import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { buildDeliveryApp, LocalTokenDelivery } from './delivery.js';

let h: Handles | null; let dir: string; let app: FastifyInstance; let clock = new Date(); let user: string; let pubId: string;
const now = () => clock;
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-delsrv-')); app = buildDeliveryApp({ sql: h.delivery, dir, now });
  user = await makeUser(h.svc, 'd@example.test'); const s = await seedOne(h.svc, user, { title: 'D' });
  const [d] = await h.svc<{ id: string }[]>`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, caption_body, state, approved_at, approved_by) VALUES (${user}, ${s.photoId}, ${s.versionId}, 'c', 'SCHEDULED', now(), ${user}) RETURNING id`;
  const [p] = await h.svc<{ id: string }[]>`INSERT INTO scheduled_publications (user_id, draft_id, scheduled_at, timezone, state) VALUES (${user}, ${d!.id}, now() + interval '1 hour', 'UTC', 'SCHEDULED') RETURNING id`; pubId = p!.id;
});
afterAll(async () => { if (h) { await app.close(); await wipe(h.svc); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const provider = (o: { ttlSeconds?: number; maxHits?: number } = {}) => new LocalTokenDelivery({ sql: h!.svc, dir, baseUrl: 'http://delivery.invalid', now, ...o });
const tokenOf = (url: string) => url.split('/d/')[1]!;
const get = (token: string) => app.inject({ method: 'GET', url: `/d/${token}` });

describe('the isolated delivery service', () => {
  it('serves the copy for a valid token, with no caching and no sniffing — and nothing else', async (ctx) => {
    need(ctx); clock = new Date();
    const out = await provider().prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    const r = await get(tokenOf(out.url)); expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toBe('image/jpeg'); expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.rawPayload.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    for (const u of ['/', '/d', '/d/', '/api/auth/me', '/health', '/../etc/passwd']) expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/d/${tokenOf(out.url)}` })).statusCode).toBe(404);
  });
  it('the token is stored only as a hash; the lifetime is capped at the schema’s hour and the default is 20 minutes', async (ctx) => {
    need(ctx); clock = new Date();
    const out = await provider().prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') }); const tok = tokenOf(out.url);
    const [t] = await h!.svc`SELECT token_hash, expires_at, created_at, max_hits FROM delivery_tokens ORDER BY created_at DESC LIMIT 1`; expect(Buffer.from(t!.token_hash).toString('base64url')).not.toBe(tok); expect(JSON.stringify(t)).not.toContain(tok);
    expect(new Date(t!.expires_at).getTime() - new Date(t!.created_at).getTime()).toBe(1_200_000); expect(t!.max_hits).toBe(5);
    await expect(provider({ ttlSeconds: 99_999 }).prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') })).resolves.toBeTruthy();       // clamped below the one-hour constraint
  });
  it('every failure looks the same: unknown, malformed, expired, revoked and used-up tokens', async (ctx) => {
    need(ctx); clock = new Date();
    const live = await provider().prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') });
    const revoked = await provider().prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') }); await revoked.revoke();
    const used = await provider({ maxHits: 2 }).prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') }); await get(tokenOf(used.url)); await get(tokenOf(used.url));
    const expiring = await provider({ ttlSeconds: 60 }).prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') });
    const bodies = new Set<string>();
    for (const t of [randomUUID(), 'short', 'a'.repeat(43), '../'.repeat(15), tokenOf(revoked.url), tokenOf(used.url)]) { const r = await get(t); expect(r.statusCode, t).toBe(404); bodies.add(`${r.body}|${r.headers['content-type']}|${r.headers['cache-control']}`); }
    expect(bodies.size).toBe(1); expect((await get(tokenOf(live.url))).statusCode).toBe(200);
    clock = new Date(Date.now() + 120_000); expect((await get(tokenOf(expiring.url))).statusCode).toBe(404); const r2 = await get(tokenOf(expiring.url)); expect(`${r2.body}|${r2.headers['content-type']}|${r2.headers['cache-control']}`).toBe([...bodies][0]); clock = new Date();
  });
  it('counts hits and stops at the limit; a deleted file is a plain 404 and never a path leak', async (ctx) => {
    need(ctx); clock = new Date();
    const out = await provider({ maxHits: 3 }).prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') }); const t = tokenOf(out.url);
    expect([(await get(t)).statusCode, (await get(t)).statusCode, (await get(t)).statusCode, (await get(t)).statusCode]).toEqual([200, 200, 200, 404]);
    const gone = await provider().prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') }); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    const r = await get(tokenOf(gone.url)); expect(r.statusCode).toBe(404); expect(r.body).not.toMatch(/ENOENT|\/tmp|pv-delsrv/);
  });
  it('revoking removes the file as well as the token', async (ctx) => {
    need(ctx); clock = new Date();
    const out = await provider().prepare({ userId: user, publicationId: pubId, jpeg: Buffer.from('x') }); expect(fs.readdirSync(dir).length).toBe(1); await out.revoke(); expect(fs.readdirSync(dir)).toEqual([]); expect((await get(tokenOf(out.url))).statusCode).toBe(404);
  });
  it('the delivery database role can look up and count tokens — and nothing else', async (ctx) => {
    need(ctx);
    await expect(h!.delivery`SELECT 1 FROM photos LIMIT 1`).rejects.toThrow(/permission denied/); await expect(h!.delivery`SELECT 1 FROM users LIMIT 1`).rejects.toThrow(/permission denied/); await expect(h!.delivery`SELECT 1 FROM social_accounts LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(h!.delivery`DELETE FROM delivery_tokens`).rejects.toThrow(/permission denied/); await expect(h!.delivery`UPDATE delivery_tokens SET expires_at = now() + interval '30 days'`).rejects.toThrow(/permission denied/);
    await expect(h!.delivery`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, expires_at) VALUES (${user}, ${pubId}, ${Buffer.alloc(32)}, 'x.jpg', now() + interval '10 minutes')`).rejects.toThrow(/permission denied/);
    expect((await h!.delivery`SELECT count(*)::int AS n FROM delivery_tokens`)[0]!.n).toBeGreaterThan(0);
  });
  it('the database refuses a token that would live more than an hour', async (ctx) => {
    need(ctx);
    await expect(h!.svc`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, expires_at) VALUES (${user}, ${pubId}, ${Buffer.alloc(32, 7)}, 'x.jpg', now() + interval '2 hours')`).rejects.toThrow(/check constraint/);
  });
});
