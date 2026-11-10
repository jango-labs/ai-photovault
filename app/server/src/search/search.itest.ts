import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne, type SeedOpts } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import type { Job } from '../jobs/worker.js';
import { embedHandler } from './index.js';
import { LOCAL_EMBEDDING_DIMS } from './embedding.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let ua: string, ub: string;
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); app = makeApp(h);
  ua = await makeUser(h.svc, 'a@example.test'); ub = await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

async function photo(user: string, o: SeedOpts & { species?: [string, string]; tags?: string[]; colours?: string[]; description?: string; hidden?: boolean; posted?: boolean; ready?: boolean } = {}) {
  const s = await seedOne(h!.svc, user, o);
  if (o.description) await h!.svc`UPDATE photos SET description = ${o.description}, description_source = 'USER_DEFINED' WHERE id = ${s.photoId}`;
  if (o.hidden) await h!.svc`UPDATE photos SET hidden = true WHERE id = ${s.photoId}`;
  if (o.ready) await h!.svc`UPDATE photo_versions SET deriv_status = 'READY' WHERE id = ${s.versionId}`;
  if (o.species) {
    const [sp] = await h!.svc<{ id: string }[]>`INSERT INTO species (user_id, common_name, scientific_name) VALUES (${user}, ${o.species[0]}, ${o.species[1]}) ON CONFLICT (user_id, lower(common_name)) DO UPDATE SET common_name = excluded.common_name RETURNING id`;
    await h!.svc`INSERT INTO photo_species (user_id, photo_id, species_id, confidence, source, status) VALUES (${user}, ${s.photoId}, ${sp!.id}, 0.9, 'AI_INFERRED', 'SUGGESTED')`;
  }
  if (o.tags || o.colours) await h!.svc`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, primary_subject, description, suggested_title, scenes, tags, dominant_color_names, scores, overall_score, confidence)
    VALUES (${user}, ${s.versionId}, 'local', 'local-image-v1', 'local-1', 'local', NULL, NULL, NULL, '{}', ${o.tags ?? []}, ${o.colours ?? []}, '{}'::jsonb, NULL, '{}'::jsonb)`;
  if (o.posted) {
    const [acct] = await h!.svc<{ id: string }[]>`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, status) VALUES (${user}, 'instagram', ${randomUUID()}, 'x', 'BUSINESS', 'DISCONNECTED') RETURNING id`;
    const [post] = await h!.svc<{ id: string }[]>`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, media_type, posted_at, caption, origin, raw) VALUES (${user}, ${acct!.id}, ${randomUUID()}, 'IMAGE', now(), 'c', 'SYNCED', '{}'::jsonb) RETURNING id`;
    const [media] = await h!.svc<{ id: string }[]>`INSERT INTO social_post_media (user_id, social_post_id, position, platform_media_id) VALUES (${user}, ${post!.id}, 0, ${randomUUID()}) RETURNING id`;
    await h!.svc`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, photo_version_id, state, phash_distance, score) VALUES (${user}, ${media!.id}, ${s.photoId}, ${s.versionId}, 'EXACT_MATCH', 0, 1)`;
  }
  return s;
}
const vec = (f: (k: number) => number) => { const a = Array.from({ length: LOCAL_EMBEDDING_DIMS }, (_, k) => f(k)); const n = Math.hypot(...a); return `[${a.map((x) => (x / n).toFixed(6)).join(',')}]`; };
const embed = (user: string, versionId: string, v: string) => h!.svc`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${user}, ${versionId}, 'local-visual-v1', 'image', ${LOCAL_EMBEDDING_DIMS}, ${v}::halfvec)`;
const ids = (b: { items: Array<{ id: string }> }) => b.items.map((i) => i.id);
const q = (s: string, extra = '') => `/api/search?q=${encodeURIComponent(s)}${extra}`;

describe('GET /api/search', () => {
  it('understands "lions in Kenya in 2024 that I never posted" and explains it', async (ctx) => {
    need(ctx);
    const want = await photo(ua, { title: 'Pride at dusk', species: ['Lion', 'Panthera leo'], location: 'Kenya', year: 2024, captureAt: new Date('2024-06-01T10:00:00Z') });
    await photo(ua, { title: 'Posted pride', species: ['Lion', 'Panthera leo'], location: 'Kenya', year: 2024, captureAt: new Date('2024-06-02T10:00:00Z'), posted: true });
    await photo(ua, { title: 'Old pride', species: ['Lion', 'Panthera leo'], location: 'Kenya', year: 2023, captureAt: new Date('2023-06-02T10:00:00Z') });
    await photo(ua, { title: 'Other country', species: ['Lion', 'Panthera leo'], location: 'Tanzania', year: 2024, captureAt: new Date('2024-06-03T10:00:00Z') });
    await photo(ua, { title: 'Other animal', species: ['African elephant', 'Loxodonta africana'], location: 'Kenya', year: 2024, captureAt: new Date('2024-06-04T10:00:00Z') });
    await photo(ua, { title: 'Hidden pride', species: ['Lion', 'Panthera leo'], location: 'Kenya', year: 2024, hidden: true });
    const r = await A.json('GET', q('lions in Kenya in 2024 that I never posted'));
    expect(r.status).toBe(200); expect(ids(r.body)).toEqual([want.photoId]); expect(r.body.total).toBe(1);
    expect(r.body.parsed.understood.map((u: { label: string }) => u.label).sort()).toEqual(['2024', 'Kenya', 'Lion', 'never posted']);
    expect(r.body.semantic.available).toBe(false); expect(r.body.relaxed).toBe(false);
  });

  it('removing an "understood" phrase drops that filter', async (ctx) => {
    need(ctx);
    const r = await A.json('GET', q('lions in Kenya in 2024 that I never posted', '&exclude=year:2024'));
    expect(r.body.parsed.understood.map((u: { label: string }) => u.label)).not.toContain('2024');
    expect(r.body.total).toBeGreaterThanOrEqual(2);           // the 2023 Kenya lion joins the 2024 one
  });

  it('ranks title above description, stems, matches prefixes, and a change of title is searchable immediately (trigger-fed index)', async (ctx) => {
    need(ctx);
    const a = await photo(ua, { title: 'Heron over the marsh' }); const b = await photo(ua, { title: 'Quiet morning', description: 'A heron stands in the reeds.' });
    expect(ids((await A.json('GET', q('heron'))).body)).toEqual([a.photoId, b.photoId]);
    expect(ids((await A.json('GET', q('herons'))).body)).toContain(a.photoId);                    // stemmed
    expect(ids((await A.json('GET', q('hero'))).body)).toContain(a.photoId);                      // prefix while typing
    expect((await A.json('PATCH', `/api/library/photos/${a.photoId}/metadata`, { title: 'Egret over the marsh' })).status).toBe(200);
    expect(ids((await A.json('GET', q('heron'))).body)).toEqual([b.photoId]);
    expect(ids((await A.json('GET', q('egret'))).body)).toEqual([a.photoId]);
  });

  it('ratings, orientation, favourites and looks are applied as filters; colours and tones come from the measured analysis', async (ctx) => {
    need(ctx);
    const warm = await photo(ua, { title: 'Amber dune', rating: 5, width: 3000, height: 5000, tags: ['warm tones', 'sharp'], colours: ['amber', 'brown'] });
    await photo(ua, { title: 'Blue dune', rating: 5, width: 3000, height: 5000, tags: ['cool tones'], colours: ['blue'] });
    await photo(ua, { title: 'Amber dune low', rating: 2, width: 3000, height: 5000, tags: ['warm tones'], colours: ['amber'] });
    await photo(ua, { title: 'Amber dune wide', rating: 5, width: 6000, height: 3000, tags: ['warm tones'], colours: ['amber'] });
    const r = await A.json('GET', q('best warm amber portrait dunes'));
    expect(ids(r.body)).toEqual([warm.photoId]); expect(r.body.parsed.text).toBe('dunes');
  });

  it('relaxes to "any word" when no photograph has all of them, and says so', async (ctx) => {
    need(ctx);
    const a = await photo(ua, { title: 'Pangolin trail' }); const b = await photo(ua, { title: 'Quokka smile' });
    const r = await A.json('GET', q('pangolin quokka'));
    expect(r.body.relaxed).toBe(true); expect(ids(r.body).sort()).toEqual([a.photoId, b.photoId].sort());
  });

  it('pages with offset, reports the next offset, and refuses to go beyond the bound', async (ctx) => {
    need(ctx);
    for (let i = 0; i < 5; i++) await photo(ua, { title: `Walrus ${i}`, captureAt: new Date(`2020-01-0${i + 1}T00:00:00Z`) });
    const p1 = (await A.json('GET', q('walrus', '&limit=2'))).body; expect(p1.total).toBe(5); expect(p1.items).toHaveLength(2); expect(p1.nextOffset).toBe(2);
    const p2 = (await A.json('GET', q('walrus', '&limit=2&offset=2'))).body; const p3 = (await A.json('GET', q('walrus', '&limit=2&offset=4'))).body;
    expect(p3.items).toHaveLength(1); expect(p3.nextOffset).toBeNull();
    expect(new Set([...ids(p1), ...ids(p2), ...ids(p3)]).size).toBe(5);
    expect((await A.json('GET', q('walrus', '&offset=5001'))).status).toBe(400); expect((await A.json('GET', q('walrus', '&limit=999'))).status).toBe(400);
    expect((await A.json('GET', '/api/search?q=x&bogus=1')).status).toBe(400);
  });

  it('treats hostile input as plain words: no injection, no crash, no operators', async (ctx) => {
    need(ctx);
    for (const s of ["'; DROP TABLE photos; --", 'lion & | ! ( ) :* <->', '\\', '%_', 'a'.repeat(300), '\u0000x']) {
      const r = await A.json('GET', q(s)); expect([200, 400], s).toContain(r.status);
    }
    expect((await h!.svc`SELECT count(*)::int AS n FROM photos`)[0]!.n).toBeGreaterThan(0);
  });

  it('never returns another account’s photographs, or hidden ones', async (ctx) => {
    need(ctx);
    await photo(ub, { title: 'Secret narwhal' }); const mine = await photo(ua, { title: 'Public narwhal' });
    expect(ids((await A.json('GET', q('narwhal'))).body)).toEqual([mine.photoId]);
    expect((await B.json('GET', q('narwhal'))).body.total).toBe(1);
    expect((await B.json('GET', q('public narwhal'))).body.items.map((i: { title: string }) => i.title)).toEqual(['Secret narwhal']);
  });
});

describe('Find similar', () => {
  it('orders by visual similarity, excludes itself and hidden photographs, and never crosses accounts', async (ctx) => {
    need(ctx);
    const src = await photo(ua, { title: 'sim-src' }), near = await photo(ua, { title: 'sim-near' }), mid = await photo(ua, { title: 'sim-mid' }), far = await photo(ua, { title: 'sim-far' }), hid = await photo(ua, { title: 'sim-hidden', hidden: true }), other = await photo(ub, { title: 'sim-other' });
    await embed(ua, src.versionId, vec((k) => (k < 128 ? 1 : 0))); await embed(ua, near.versionId, vec((k) => (k < 128 ? 1 : 0.02)));
    await embed(ua, mid.versionId, vec((k) => (k < 128 ? 1 : k < 192 ? 1 : 0))); await embed(ua, far.versionId, vec((k) => (k < 128 ? 0 : 1)));
    await embed(ua, hid.versionId, vec((k) => (k < 128 ? 1 : 0.01))); await embed(ub, other.versionId, vec((k) => (k < 128 ? 1 : 0)));
    const r = await A.json('GET', `/api/search/similar/${src.photoId}`);
    expect(r.status).toBe(200); expect(ids(r.body)).toEqual([near.photoId, mid.photoId, far.photoId]);
    const sims = r.body.items.map((i: { similarity: number }) => i.similarity); expect(sims[0]).toBeGreaterThan(0.99); expect(sims).toEqual([...sims].sort((a, b) => b - a));
    expect((await B.json('GET', `/api/search/similar/${src.photoId}`)).status).toBe(404);
  });
  it('409 when the photograph has no embedding yet; 404 for unknown ids; 400 for malformed ids', async (ctx) => {
    need(ctx);
    const p = await photo(ua, { title: 'not embedded' });
    expect((await A.json('GET', `/api/search/similar/${p.photoId}`)).status).toBe(409);
    expect((await A.json('GET', `/api/search/similar/${randomUUID()}`)).status).toBe(404); expect((await A.json('GET', '/api/search/similar/nope')).status).toBe(400);
  });
  it('the nearest-neighbour query can use the HNSW index', async (ctx) => {
    need(ctx);
    const plan = await h!.svc.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx.unsafe(`EXPLAIN SELECT photo_version_id FROM photo_embeddings WHERE model = 'local-visual-v1' AND kind = 'image' ORDER BY embedding::halfvec(256) <=> (SELECT embedding::halfvec(256) FROM photo_embeddings WHERE model = 'local-visual-v1' AND kind = 'image' LIMIT 1) LIMIT 10`);
    });
    const text = plan.map((r) => String(Object.values(r)[0])).join('\n');
    expect(text, text).toContain('photo_embeddings_local_hnsw');
  });
});

describe('search history and saved searches', () => {
  it('records only when asked, de-duplicates, can be cleared, and is private', async (ctx) => {
    need(ctx);
    await A.json('GET', q('tern')); expect((await A.json('GET', '/api/search/history')).body.items).toEqual([]);
    await A.json('GET', q('Tern', '&record=true')); await A.json('GET', q('tern', '&record=true')); await A.json('GET', q('gull', '&record=true'));
    const hst = (await A.json('GET', '/api/search/history')).body.items; expect(hst.map((x: { q: string }) => x.q)).toEqual(['gull', 'tern']);
    expect((await B.json('GET', '/api/search/history')).body.items).toEqual([]);
    expect((await B.json('DELETE', `/api/search/history/${hst[0].id}`)).status).toBe(404);
    expect((await A.json('DELETE', `/api/search/history/${hst[0].id}`)).status).toBe(200);
    expect((await A.json('DELETE', '/api/search/history')).body.removed).toBe(1);
  });
  it('saves a query (not its results), rejects duplicate names, deletes, and keeps other accounts out', async (ctx) => {
    need(ctx);
    const s = await A.json('POST', '/api/search/saved', { name: 'Unposted Kenya lions', q: 'lions in Kenya never posted', exclude: ['year:2024'] }); expect(s.status).toBe(201);
    expect((await A.json('POST', '/api/search/saved', { name: 'unposted kenya LIONS', q: 'x' })).status).toBe(409);
    expect((await A.json('POST', '/api/search/saved', { name: '', q: 'x' })).status).toBe(400);
    expect((await A.json('GET', '/api/search/saved')).body.items).toEqual([expect.objectContaining({ name: 'Unposted Kenya lions', q: 'lions in Kenya never posted', exclude: ['year:2024'] })]);
    expect((await B.json('GET', '/api/search/saved')).body.items).toEqual([]);
    expect((await B.json('DELETE', `/api/search/saved/${s.body.id}`)).status).toBe(404);
    const [c] = await h!.svc`SELECT kind, query FROM collections WHERE id = ${s.body.id}`; expect(c).toMatchObject({ kind: 'SAVED_SEARCH' });
    expect((await A.json('DELETE', `/api/search/saved/${s.body.id}`)).status).toBe(200); expect((await A.json('GET', '/api/search/saved')).body.items).toEqual([]);
  });
});

describe('discovery, status and reindex', () => {
  it('lists what the library holds with counts, and example searches built from it', async (ctx) => {
    need(ctx);
    const d = (await A.json('GET', '/api/search/discover')).body;
    expect(d.species[0]).toMatchObject({ name: 'Lion' }); expect(d.species[0].n).toBeGreaterThanOrEqual(4); expect(d.places.map((p: { name: string }) => p.name)).toContain('Kenya'); expect(d.examples.length).toBeGreaterThan(0);
  });
  it('reindex rebuilds documents and queues each missing embedding once', async (ctx) => {
    need(ctx);
    await h!.svc`UPDATE photo_versions SET deriv_status = 'READY' WHERE user_id = ${ua}`;
    await h!.svc`DELETE FROM search_documents WHERE user_id = ${ua}`;
    const r1 = (await A.json('POST', '/api/search/reindex')).body; const photos = (await h!.svc`SELECT count(*)::int AS n FROM photos WHERE user_id = ${ua} AND deleted_at IS NULL`)[0]!.n;
    expect(r1.indexed).toBe(photos); expect(r1.embeddingsQueued).toBeGreaterThan(0);
    const r2 = (await A.json('POST', '/api/search/reindex')).body; expect(r2.embeddingsQueued).toBe(0);
    const st = (await A.json('GET', '/api/search/status')).body; expect(st).toMatchObject({ photos, indexed: photos, embeddingModel: 'local-visual-v1' }); expect(st.embeddingsQueued).toBe(r1.embeddingsQueued);
  });
});

describe('embed.image job', () => {
  it('embeds the preview once (idempotent), and fails permanently for a vanished version', async (ctx) => {
    need(ctx);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-embed-'));
    try {
      const p = await photo(ua, { title: 'embed me', ready: true });
      fs.mkdirSync(path.join(dir, p.versionId)); await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg().toFile(path.join(dir, p.versionId, 'thumb.jpg'));
      const run = embedHandler(h!.svc, dir); const job = { id: randomUUID(), user_id: ua, kind: 'embed.image', payload: { versionId: p.versionId }, attempts: 1 } as unknown as Job;
      await run(job); await run(job);
      expect((await h!.svc`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_version_id = ${p.versionId}`)[0]!.n).toBe(1);
      await expect(run({ ...job, payload: { versionId: randomUUID() } } as Job)).rejects.toThrow(/no longer exists/);
      await expect(run({ ...job, payload: { versionId: 'x' } } as Job)).rejects.toThrow(/malformed/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('access control', () => {
  it('every search endpoint requires a signed-in session; mutating ones require the CSRF token', async (ctx) => {
    need(ctx);
    const anon = new ApiClient(app);
    for (const [m, u] of [['GET', '/api/search?q=x'], ['GET', `/api/search/similar/${randomUUID()}`], ['GET', '/api/search/history'], ['DELETE', '/api/search/history'], ['GET', '/api/search/saved'], ['POST', '/api/search/saved'], ['GET', '/api/search/discover'], ['GET', '/api/search/status'], ['POST', '/api/search/reindex']] as const)
      expect((await anon.json(m, u, m === 'POST' ? {} : undefined)).status, `${m} ${u}`).toBe(401);
    expect((await A.req('POST', '/api/search/reindex', undefined, { csrf: false })).statusCode).toBe(403);
  });
});
