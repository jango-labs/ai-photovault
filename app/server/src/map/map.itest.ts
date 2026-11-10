import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne, type SeedOpts } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let ua: string, ub: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); app = makeApp(h);
  ua = await makeUser(h.svc, 'a@example.test'); ub = await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
  const at = async (name: string, lat: number | null, lon: number | null, src: string | null, o: SeedOpts & { hidden?: boolean; user?: string } = {}) => {
    const s = await seedOne(h!.svc, o.user ?? ua, { title: name, ...o }); ids[name] = s.photoId;
    if (lat !== null) await h!.svc`UPDATE photo_versions SET gps_lat = ${lat}, gps_lon = ${lon}, gps_source = ${src}::meta_source WHERE id = ${s.versionId}`;
    if (o.hidden) await h!.svc`UPDATE photos SET hidden = true WHERE id = ${s.photoId}`;
  };
  await at('nairobi1', -1.2921, 36.8219, 'EXIF', { rating: 2, location: 'Kenya' }); await at('nairobi2', -1.2925, 36.8221, 'EXIF', { rating: 5, location: 'Kenya' }); await at('nairobi3', -1.2919, 36.8215, 'IPTC', { rating: 3, location: 'Kenya' });
  await at('mara1', -1.5, 35.1, 'USER_DEFINED', { location: 'Kenya' }); await at('mara2', -1.502, 35.098, 'USER_DEFINED', { location: 'Kenya' });
  await at('oslo', 59.9139, 10.7522, 'AI_INFERRED', { location: 'Norway', rating: 4 });
  await at('hidden', -1.29, 36.82, 'EXIF', { hidden: true }); await at('named-only', null, null, null, { location: 'Kenya' }); await at('nowhere', null, null, null);
  await at('theirs', -1.29, 36.82, 'EXIF', { user: ub });
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const clusters = (c: ApiClient, q: string) => c.json('GET', `/api/map/clusters?${q}`);
const WORLD = 'bbox=-180,-85,180,85';

describe('GET /api/map/clusters', () => {
  it('every placed photograph is in exactly one cluster; hidden and other accounts’ photographs are not', async (ctx) => {
    need(ctx);
    for (const z of [0, 2, 6, 12, 18]) { const r = await clusters(A, `${WORLD}&zoom=${z}`); expect(r.status).toBe(200); expect(r.body.shown, `zoom ${z}`).toBe(6); expect(r.body.clusters.reduce((a: number, c: { count: number }) => a + c.count, 0)).toBe(6); }
  });
  it('zooming in splits clusters; at street zoom the two Kenyan sites and Oslo are apart, with the right counts', async (ctx) => {
    need(ctx);
    const far = (await clusters(A, `${WORLD}&zoom=1`)).body.clusters.length; const near = (await clusters(A, `${WORLD}&zoom=12`)).body.clusters;
    expect(near.length).toBeGreaterThan(far); expect(near.map((c: { count: number }) => c.count).sort()).toEqual([1, 2, 3]);
    const nairobi = near.find((c: { count: number }) => c.count === 3); expect(nairobi.lat).toBeCloseTo(-1.2922, 3); expect(nairobi.lon).toBeCloseTo(36.8218, 3);
    expect(nairobi.bbox[0]).toBeLessThanOrEqual(nairobi.lon); expect(nairobi.bbox[2]).toBeGreaterThanOrEqual(nairobi.lon);
  });
  it('says where each cluster’s coordinates came from, and offers the best photograph as its thumbnail', async (ctx) => {
    need(ctx);
    const near = (await clusters(A, `${WORLD}&zoom=12`)).body.clusters;
    const nairobi = near.find((c: { count: number }) => c.count === 3); expect(nairobi.sources).toEqual({ EXIF: 2, IPTC: 1 }); expect(nairobi.photoId).toBe(ids.nairobi2);   // the 5-star one
    expect(near.find((c: { count: number }) => c.count === 2).sources).toEqual({ USER_DEFINED: 2 });
    expect(near.find((c: { count: number }) => c.count === 1)).toMatchObject({ sources: { AI_INFERRED: 1 }, photoId: ids.oslo });
  });
  it('a bounding box limits what is counted, edges included', async (ctx) => {
    need(ctx);
    expect((await clusters(A, 'bbox=34,-3,36,0&zoom=8')).body.shown).toBe(2); expect((await clusters(A, 'bbox=36.8,-1.3,36.9,-1.2&zoom=8')).body.shown).toBe(3); expect((await clusters(A, 'bbox=0,0,1,1&zoom=8')).body).toMatchObject({ clusters: [], shown: 0 });
    expect((await clusters(A, 'bbox=10.7522,59.9139,10.7522,59.9139&zoom=8')).body.shown).toBe(1);
  });
  it('library filters apply: rating, provenance, camera-less combinations', async (ctx) => {
    need(ctx);
    expect((await clusters(A, `${WORLD}&zoom=2&rating=5`)).body.shown).toBe(1); expect((await clusters(A, `${WORLD}&zoom=2&rating=4&rating=5`)).body.shown).toBe(2);
    expect((await clusters(A, `${WORLD}&zoom=2&gps=USER_DEFINED`)).body.shown).toBe(2); expect((await clusters(A, `${WORLD}&zoom=2&gps=EXIF&gps=AI_INFERRED`)).body.shown).toBe(3);
    expect((await clusters(A, `${WORLD}&zoom=2&location=Norway`)).body.shown).toBe(1); expect((await clusters(A, `${WORLD}&zoom=2&hidden=true`)).body.shown).toBe(1);
  });
  it('another account sees only its own photographs', async (ctx) => {
    need(ctx);
    const r = (await clusters(B, `${WORLD}&zoom=12`)).body; expect(r.shown).toBe(1); expect(r.clusters[0].photoId).toBe(ids.theirs);
  });
  it('refuses a missing, inverted or out-of-range box, a bad zoom, and unknown parameters', async (ctx) => {
    need(ctx);
    for (const q of ['zoom=2', 'bbox=10,0,0,5&zoom=2', 'bbox=0,10,5,0&zoom=2', 'bbox=-200,0,0,5&zoom=2', 'bbox=0,-95,5,5&zoom=2', 'bbox=a,b,c,d&zoom=2', 'bbox=1,2,3&zoom=2', `${WORLD}&zoom=19`, `${WORLD}&zoom=-1`, `${WORLD}&cell=5`, `${WORLD}&bogus=1`, `${WORLD}&gps=SATELLITE`])
      expect((await clusters(A, q)).status, q).toBe(400);
  });
});

describe('GET /api/map/summary', () => {
  it('counts what can and cannot be placed, and by what evidence; place names are not coordinates', async (ctx) => {
    need(ctx);
    const s = (await A.json('GET', '/api/map/summary')).body;
    expect(s).toEqual({ total: 8, placed: 6, withoutCoordinates: 2, withPlaceNameOnly: 1, typedPlaceNameOnly: 0, sources: { EXIF: 2, IPTC: 1, USER_DEFINED: 2, AI_INFERRED: 1 } });
    expect((await A.json('GET', '/api/map/summary?rating=5')).body).toMatchObject({ total: 1, placed: 1 });
    expect((await A.json('GET', '/api/map/summary?bbox=1,2,3,4')).status).toBe(400);
  });
});

describe('Library: map-area and provenance filters', () => {
  it('bbox and gps filter the library list and counts; the same box gives the same total as the map', async (ctx) => {
    need(ctx);
    const inBox = (await A.json('GET', '/api/library/photos?bbox=34,-3,36,0')).body; expect(inBox.total).toBe(2); expect(inBox.items.map((i: { title: string }) => i.title).sort()).toEqual(['mara1', 'mara2']);
    expect((await A.json('GET', '/api/library/photos?gps=none')).body.total).toBe(2); expect((await A.json('GET', '/api/library/photos?gps=none&gps=AI_INFERRED')).body.total).toBe(3);
    expect((await A.json('GET', '/api/library/photos?bbox=-180,-85,180,85')).body.total).toBe((await clusters(A, `${WORLD}&zoom=3`)).body.shown);
    expect((await A.json('GET', '/api/library/photos?bbox=5,4,3,2')).status).toBe(400);
  });
  it('a smart collection can be an area', async (ctx) => {
    need(ctx);
    const c = (await A.json('POST', '/api/collections', { name: 'Mara area', kind: 'SMART', filters: { view: 'all', bbox: [34, -3, 36, 0] } })).body.id;
    expect((await A.json('GET', `/api/collections/${c}`)).body.count).toBe(2);
  });
  it('map routes need a session', async (ctx) => {
    need(ctx);
    const anon = new ApiClient(app);
    for (const u of [`/api/map/clusters?${WORLD}`, '/api/map/summary']) expect((await anon.json('GET', u)).status, u).toBe(401);
    void randomUUID;
  });
});
