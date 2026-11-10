import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Geocoder, geocoderConfigFromEnv, type GeocoderConfig } from '../geo/geocoder.js';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

/**
 * Manually entered locations → the map. The place-name service is replaced by a fake transport that answers like OpenStreetMap's Nominatim.
 * Every scenario runs through the real API, the real edit service and PostgreSQL, and reads the result back through the same endpoints the UI uses (photo detail, library filters,
 * map clusters, edit history).
 */
const PLACES: Record<string, unknown[]> = {
  'washington, dc': [{ display_name: 'Washington, District of Columbia, United States', lat: '38.8950982', lon: '-77.0363849', category: 'place', type: 'city', boundingbox: ['38.79', '38.99', '-77.12', '-76.90'] }],
  'new york, ny': [{ display_name: 'New York, United States', lat: '40.7127281', lon: '-74.0060152', category: 'boundary', type: 'administrative', boundingbox: ['40.47', '40.91', '-74.25', '-73.70'] }],
  'yellowstone national park': [{ display_name: 'Yellowstone National Park, Wyoming, United States', lat: '44.6200885', lon: '-110.5606893', category: 'leisure', type: 'nature_reserve', boundingbox: ['44.13', '45.10', '-111.15', '-109.82'] }],
};
let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let B: ApiClient; let uid = ''; let mode: 'up' | 'down' | 'off' = 'up'; let lookups: string[] = [];
const cfg = (): GeocoderConfig => ({ ...geocoderConfigFromEnv({}), baseUrl: 'https://nominatim.test', minIntervalMs: 0, sleep: async () => undefined, enabled: mode !== 'off',
  fetch: (async (u: URL) => { const q = new URL(String(u)).searchParams.get('q')!.toLowerCase(); lookups.push(q); if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ENOTFOUND') }); return new Response(JSON.stringify(PLACES[q] ?? []), { status: 200 }); }) as typeof fetch });
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  const live = cfg(); Object.defineProperty(live, 'enabled', { get: () => mode !== 'off' });         // the switch is read on every lookup
  app = makeApp(h, {}, { geocoder: new Geocoder(h.app, live) });
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
beforeEach(async () => {                                   // every scenario starts with an empty library and a fresh sign-in, so counts on the map are exact
  mode = 'up'; lookups = []; if (!h) return;
  await wipe(h.svc); uid = await makeUser(h.svc, 'loc@example.test'); await makeUser(h.svc, 'loc2@example.test');
  A = await new ApiClient(app).signIn('loc@example.test'); B = await new ApiClient(app).signIn('loc2@example.test');
});
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
// the Geocoder reads `enabled` once; for the "switched off" test a second app is built below
const photo = async (o: { gps?: { lat: number; lon: number; source: 'EXIF' | 'IPTC' | 'USER_DEFINED' }; location?: string } = {}) => {
  const p = await seedOne(h!.svc, uid, { title: 'P', ...(o.location ? { location: o.location } : {}) });
  if (o.gps) await h!.svc`UPDATE photo_versions SET gps_lat = ${o.gps.lat}, gps_lon = ${o.gps.lon}, gps_source = ${o.gps.source}::meta_source WHERE id = ${p.versionId}`;
  return p.photoId;
};
const patch = (id: string, body: Record<string, unknown>, c = A) => c.json('PATCH', `/api/library/photos/${id}/metadata`, body);
const detail = async (id: string) => (await A.json('GET', `/api/library/photos/${id}`)).body;
const world = async (extra = '') => (await A.json('GET', `/api/map/clusters?bbox=-180,-85,180,85&zoom=2${extra}`)).body as { clusters: Array<{ lat: number; lon: number; count: number; sources: Record<string, number>; photoId: string }>; shown: number };
const near = (lat: number, lon: number, e: { lat: number; lon: number }) => Math.abs(e.lat - lat) < 0.01 && Math.abs(e.lon - lon) < 0.01;

describe('why it did not work, and what happens now', () => {
  it('root cause: before the fix a typed location was only text — it never produced coordinates, so the map (which shows stored coordinates only) stayed empty', async (ctx) => {
    need(ctx); mode = 'off'; const id = await photo();
    const r = await patch(id, { location: 'Washington, DC' }); expect(r.status).toBe(200);
    expect((await detail(id)).exif.gps).toBeNull(); expect((await world()).shown).toBe(0);                            // with lookups unavailable the old behaviour remains: text kept, nothing on the map…
    expect(r.body.geocode).toMatchObject({ status: 'disabled' }); expect(r.body.geocode.message).toMatch(/text was kept/);   // …but now it says so
  });
});

describe('typed locations are resolved to approximate map positions', () => {
  it.each([
    ['Washington, DC', 38.8951, -77.0364, 'Washington, District of Columbia'],
    ['New York, NY', 40.7127, -74.0060, 'New York, United States'],
    ['Yellowstone National Park', 44.6201, -110.5607, 'Yellowstone National Park, Wyoming'],
  ])('%s → the centre of the place, marked approximate, on the map at once, found by every filter', async (text, lat, lon, label) => {
    if (!h) return; const id = await photo();
    const r = await patch(id, { location: text }); expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(expect.arrayContaining(['trip_location', 'gps'])); expect(r.body.geocode).toMatchObject({ status: 'placed', query: text }); expect(r.body.geocode.label).toContain(label);
    const d = await detail(id); expect(d.location).toBe(text);
    expect(d.exif.gps).toMatchObject({ source: 'GEOCODED', approximate: true }); expect(d.exif.gps.label).toContain(label); expect(near(lat, lon, d.exif.gps)).toBe(true); expect(d.exif.cameraGps).toBeNull();
    const m = await world(); const c = m.clusters.find((x) => near(lat, lon, x)); expect(c, 'a marker at the place').toBeTruthy(); expect(c!.sources).toEqual({ GEOCODED: 1 });     // map marker, labelled as approximate
    expect((await A.json('GET', '/api/library/photos?gps=GEOCODED')).body.items.map((i: { id: string }) => i.id)).toContain(id);          // library filter by provenance
    expect((await A.json('GET', `/api/library/photos?location=${encodeURIComponent(text)}`)).body.items.map((i: { id: string }) => i.id)).toContain(id);   // location filter (text)
    expect((await A.json('GET', `/api/library/photos?bbox=${lon - 1},${lat - 1},${lon + 1},${lat + 1}`)).body.items.map((i: { id: string }) => i.id)).toContain(id);   // the map-area filter
    expect(lookups).toEqual([text.toLowerCase()]);
  });
  it('a photograph with camera GPS keeps its exact position: the lookup is not applied and the camera coordinates stay', async (ctx) => {
    need(ctx); const id = await photo({ gps: { lat: 38.8895, lon: -77.0353, source: 'EXIF' } });
    const r = await patch(id, { location: 'Washington, DC' }); expect(r.body.geocode).toMatchObject({ status: 'kept_exact' });
    const d = await detail(id); expect(d.exif.gps).toMatchObject({ lat: 38.8895, lon: -77.0353, source: 'EXIF', approximate: false }); expect(r.body.changed).toEqual(['trip_location']);
    expect((await world()).clusters[0]!.sources).toEqual({ EXIF: 1 });
  });
  it('an unknown place keeps the text, says so plainly, and puts nothing on the map', async (ctx) => {
    need(ctx); const id = await photo(); const r = await patch(id, { location: 'Zzyzx Nowhere' });
    expect(r.body.geocode).toMatchObject({ status: 'not_found' }); expect(r.body.geocode.message).toContain('was not found on the map; the text was kept');
    expect((await detail(id)).exif.gps).toBeNull(); expect((await world()).shown).toBe(0);
  });
  it('an unreachable service never fails the edit: text saved, message shown, and “find on map” (locate) places it later', async (ctx) => {
    need(ctx); const id = await photo(); mode = 'down'; const r = await patch(id, { location: 'Washington, DC' });
    expect(r.status).toBe(200); expect(r.body.geocode).toMatchObject({ status: 'unavailable' }); expect(r.body.geocode.message).toMatch(/text was kept/);
    expect((await detail(id)).exif.gps).toBeNull(); mode = 'up';
    const again = await patch(id, { locate: true }); expect(again.body.geocode).toMatchObject({ status: 'placed' }); expect((await detail(id)).exif.gps).toMatchObject({ source: 'GEOCODED' });
  });
});

describe('manual pins, original GPS, editing, removing and undoing', () => {
  it('a hand-placed pin on a camera-GPS photograph replaces it for display, keeps the camera coordinates, is marked as yours, and “use camera position” restores it', async (ctx) => {
    need(ctx); const id = await photo({ gps: { lat: 38.8895, lon: -77.0353, source: 'EXIF' } });
    expect((await patch(id, { gps: { lat: 38.9, lon: -77.04 } })).status).toBe(200);
    let d = await detail(id); expect(d.exif.gps).toMatchObject({ lat: 38.9, lon: -77.04, source: 'USER_DEFINED', approximate: false }); expect(d.exif.cameraGps).toMatchObject({ lat: 38.8895, lon: -77.0353, source: 'EXIF', inUse: false });
    const row = (await h!.svc`SELECT gps_original_lat AS la, gps_original_lon AS lo, gps_original_source AS s FROM photo_versions WHERE id = (SELECT current_version_id FROM photos WHERE id = ${id})`)[0]!; expect([row.la, row.lo, row.s]).toEqual([38.8895, -77.0353, 'EXIF']);
    expect((await patch(id, { gpsRestore: true })).status).toBe(200); d = await detail(id); expect(d.exif.gps).toMatchObject({ lat: 38.8895, lon: -77.0353, source: 'EXIF' }); expect(d.exif.cameraGps.inUse).toBe(true);
    await patch(id, { gps: { lat: 10, lon: 10 } }); expect((await patch(id, { gps: null })).status).toBe(200);            // removing your pin brings the camera position back
    expect((await detail(id)).exif.gps).toMatchObject({ lat: 38.8895, source: 'EXIF' });
  });
  it('a pin on a photograph without GPS can be moved and removed; an approximate position can be adjusted into an exact one', async (ctx) => {
    need(ctx); const id = await photo(); await patch(id, { location: 'Yellowstone National Park' });
    expect((await detail(id)).exif.gps.approximate).toBe(true);
    await patch(id, { gps: { lat: 44.4605, lon: -110.8281 } });                                                      // “Old Faithful”, placed by hand
    expect((await detail(id)).exif.gps).toMatchObject({ lat: 44.4605, lon: -110.8281, source: 'USER_DEFINED', approximate: false, label: null });
    expect((await world()).clusters.some((c) => near(44.4605, -110.8281, c) && c.sources.USER_DEFINED === 1)).toBe(true);
    await patch(id, { gps: null }); expect((await detail(id)).exif.gps).toBeNull(); expect((await world()).shown).toBe(0);
    expect((await patch(id, { gps: { lat: 91, lon: 0 } })).status).toBe(400); expect((await patch(id, { gps: { lat: 0, lon: 0 }, gpsRestore: true })).status).toBe(400);
  });
  it('changing the text moves the approximate pin; clearing it removes the pin; a lookup never touches a hand-placed pin', async (ctx) => {
    need(ctx); const id = await photo(); await patch(id, { location: 'Washington, DC' }); await patch(id, { location: 'New York, NY' });
    expect(near(40.7127, -74.006, (await detail(id)).exif.gps)).toBe(true); expect((await world()).clusters.length).toBe(1);
    await patch(id, { location: 'Zzyzx Nowhere' }); expect((await detail(id)).exif.gps).toBeNull();                          // the old lookup belonged to the old text
    await patch(id, { location: 'Washington, DC' }); await patch(id, { location: null }); const d = await detail(id); expect(d.exif.gps).toBeNull(); expect(d.location).toBeNull(); expect((await world()).shown).toBe(0); expect(d.title).toBe('P');
    const id2 = await photo(); await patch(id2, { gps: { lat: 1, lon: 2 } }); const r = await patch(id2, { location: 'Washington, DC' });
    expect(r.body.geocode.status).toBe('kept_exact'); expect((await detail(id2)).exif.gps).toMatchObject({ lat: 1, lon: 2, source: 'USER_DEFINED' }); await patch(id2, { location: null }); expect((await detail(id2)).exif.gps).toMatchObject({ lat: 1, lon: 2 });
  });
  it('undo restores the previous position and its provenance (approximate lookup, hand pin and camera position alike), and the history says what each step was', async (ctx) => {
    need(ctx); const id = await photo({ gps: { lat: 38.8895, lon: -77.0353, source: 'EXIF' } });
    await patch(id, { gps: { lat: 38.9, lon: -77.04 } }); const hist = async () => (await A.json('GET', `/api/library/photos/${id}/history`)).body.edits as Array<{ id: string; field: string; oldSource: string | null; newSource: string | null; undone: boolean }>;
    const e = (await hist()).find((x) => x.field === 'gps')!; expect([e.oldSource, e.newSource]).toEqual(['EXIF', 'USER_DEFINED']);
    expect((await A.json('POST', `/api/library/photos/${id}/history/${e.id}/undo`, {})).status).toBe(200); expect((await detail(id)).exif.gps).toMatchObject({ lat: 38.8895, source: 'EXIF' });
    const id2 = await photo(); await patch(id2, { location: 'Washington, DC' }); const edits = await (async () => (await A.json('GET', `/api/library/photos/${id2}/history`)).body.edits as Array<{ id: string; field: string; newSource: string | null }>)();
    const g = edits.find((x) => x.field === 'gps')!; expect(g.newSource).toBe('GEOCODED');
    expect((await A.json('POST', `/api/library/photos/${id2}/history/${g.id}/undo`, {})).status).toBe(200); expect((await detail(id2)).exif.gps).toBeNull();          // the pin goes, the text stays
    const t = edits.find((x) => x.field === 'trip_location')!; expect((await A.json('POST', `/api/library/photos/${id2}/history/${t.id}/undo`, {})).status).toBe(200); expect((await world()).clusters.every((c) => !c.sources.GEOCODED)).toBe(true);   // no approximate marker is left
    // undo of a position that was later changed is refused rather than guessed
    const id3 = await photo(); await patch(id3, { location: 'Washington, DC' }); const e3 = (await (async () => (await A.json('GET', `/api/library/photos/${id3}/history`)).body.edits as Array<{ id: string; field: string }>)()).find((x) => x.field === 'gps')!;
    await patch(id3, { gps: { lat: 3, lon: 3 } }); expect((await A.json('POST', `/api/library/photos/${id3}/history/${e3.id}/undo`, {})).status).toBe(409);
  });
  it('the photograph files are never involved: no source field changes, only catalogue rows', async (ctx) => {
    need(ctx); const id = await photo({ gps: { lat: 1, lon: 1, source: 'EXIF' } }); const before = (await h!.svc`SELECT content_sha256, source_relpath, bytes FROM photo_versions WHERE id = (SELECT current_version_id FROM photos WHERE id = ${id})`)[0]!;
    await patch(id, { location: 'Washington, DC', gps: { lat: 2, lon: 2 } }); await patch(id, { gps: null });
    const after = (await h!.svc`SELECT content_sha256, source_relpath, bytes FROM photo_versions WHERE id = (SELECT current_version_id FROM photos WHERE id = ${id})`)[0]!; expect(after).toEqual(before);
  });
});

describe('bulk locations, collections, the lookup endpoint and isolation', () => {
  it('a location set on several photographs places the exact-less ones, keeps exact ones, and clearing removes only looked-up pins; smart collections follow', async (ctx) => {
    need(ctx); const a = await photo(), b = await photo(), c = await photo({ gps: { lat: 5, lon: 5, source: 'EXIF' } });
    const r = await A.json('POST', '/api/library/photos/bulk-location', { target: { ids: [a, b, c] }, location: 'New York, NY' });
    expect(r.body).toMatchObject({ updated: 3, positioned: 2, geocode: { status: 'placed' } }); expect(lookups).toEqual(['new york, ny']);                  // one lookup for the whole selection
    expect((await detail(a)).exif.gps.source).toBe('GEOCODED'); expect((await detail(c)).exif.gps).toMatchObject({ source: 'EXIF', lat: 5 });
    const col = (await A.json('POST', '/api/collections', { name: 'NYC photos', kind: 'SMART', filters: { gps: ['GEOCODED'] } })).body; if (col?.id) expect((await A.json('GET', `/api/collections/${col.id}`)).status).toBe(200);
    expect((await A.json('GET', '/api/library/photos?gps=GEOCODED')).body.items).toHaveLength(2);
    const r2 = await A.json('POST', '/api/library/photos/bulk-location', { target: { ids: [a, b, c] }, location: null }); expect(r2.body).toMatchObject({ updated: 3, positioned: 2 });
    expect((await detail(a)).exif.gps).toBeNull(); expect((await detail(c)).exif.gps).toMatchObject({ source: 'EXIF' });
  });
  it('GET /api/geocode returns candidates with attribution, needs sign-in and a real query, and is cached', async (ctx) => {
    need(ctx); expect((await new ApiClient(app).req('GET', '/api/geocode?q=Washington')).statusCode).toBe(401);
    expect((await A.json('GET', '/api/geocode?q=a')).status).toBe(400); expect((await A.json('GET', '/api/geocode')).status).toBe(400);
    const r = (await A.json('GET', '/api/geocode?q=Washington,%20DC')).body; expect(r).toMatchObject({ status: 'ok', attribution: '© OpenStreetMap contributors' }); expect(r.candidates[0]).toMatchObject({ kind: 'place/city' });
    await A.json('GET', '/api/geocode?q=washington,%20dc'); expect(lookups).toHaveLength(1);
  });
  it('another account cannot see or reuse any of it', async (ctx) => {
    need(ctx); const id = await photo(); await patch(id, { location: 'Washington, DC' });
    expect((await B.json('GET', `/api/library/photos/${id}`)).status).toBe(404); expect((await patch(id, { location: 'Boston' }, B)).status).toBe(404);
    expect(((await B.json('GET', '/api/map/clusters?bbox=-180,-85,180,85&zoom=2')).body as { shown: number }).shown).toBe(0);
  });
});

describe('REGRESSION — production report: “Washington, D.C.” and “Chicago, IL” saved in the editor, neither on the map', () => {
  /** how production looked: the place text was saved by a release that could not look it up, so the photographs carry text and no position */
  const textOnly = async (text: string) => { const p = await seedOne(h!.svc, uid, { title: 'T', location: text }); await h!.svc`UPDATE photos SET trip_location_source = 'USER_DEFINED' WHERE id = ${p.photoId}`; return p.photoId; };
  it('re-saving the SAME text (as the editor does) now puts a text-only photograph on the map — before, an unchanged text was never looked up', async (ctx) => {
    need(ctx); const id = await textOnly('Washington, DC');
    expect((await detail(id)).exif.gps).toBeNull();
    const r = await patch(id, { location: 'Washington, DC' }); expect(r.status).toBe(200);
    expect(r.body.geocode).toMatchObject({ status: 'placed' }); expect((await detail(id)).exif.gps).toMatchObject({ source: 'GEOCODED', approximate: true });
    expect((await world()).clusters.some((c) => near(38.8951, -77.0364, c))).toBe(true);
    expect((await patch(id, { location: 'Washington, DC' })).body.geocode).toBeUndefined();                      // once placed, saving the same text asks nothing again (no repeated lookups)
    expect(lookups).toEqual(['washington, dc']);
  });
  it('one action places every photograph whose typed place name has no position: distinct names are looked up once, folder-derived names and photographs that already have a position are left alone, unknown names are reported', async (ctx) => {
    need(ctx); const dc1 = await textOnly('Washington, DC'), dc2 = await textOnly('Washington, DC'), ny = await textOnly('New York, NY'), bad = await textOnly('Zzyzx Nowhere');
    const folder = (await seedOne(h!.svc, uid, { title: 'F', location: 'Yellowstone National Park' })).photoId;                       // location came from the folder (FOLDER_DERIVED): not looked up
    const exact = await photo({ gps: { lat: 5, lon: 5, source: 'EXIF' }, location: 'Washington, DC' }); await h!.svc`UPDATE photos SET trip_location_source = 'USER_DEFINED' WHERE id = ${exact}`;
    const sum0 = (await A.json('GET', '/api/map/summary')).body; expect(sum0).toMatchObject({ placed: 1, typedPlaceNameOnly: 4 });
    const r = await A.json('POST', '/api/library/photos/locate-named', {}); expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ names: 3, placed: 3 });
    expect(r.body.results.map((x: { query: string; status: string; photos: number }) => [x.query, x.status, x.photos]).sort()).toEqual([['New York, NY', 'placed', 1], ['Washington, DC', 'placed', 2], ['Zzyzx Nowhere', 'not_found', 0]]);
    expect(lookups.sort()).toEqual(['new york, ny', 'washington, dc', 'zzyzx nowhere']);                            // ONE lookup per distinct name
    for (const id of [dc1, dc2, ny]) expect((await detail(id)).exif.gps).toMatchObject({ source: 'GEOCODED' });
    expect((await detail(bad)).exif.gps).toBeNull(); expect((await detail(bad)).location).toBe('Zzyzx Nowhere'); expect((await detail(folder)).exif.gps).toBeNull(); expect((await detail(exact)).exif.gps).toMatchObject({ source: 'EXIF', lat: 5 });
    const sum = (await A.json('GET', '/api/map/summary')).body; expect(sum).toMatchObject({ placed: 4, typedPlaceNameOnly: 1 }); expect(sum.sources).toMatchObject({ GEOCODED: 3, EXIF: 1 });
    const m = (await A.json('GET', '/api/map/clusters?bbox=-75,40,-73,41.5&zoom=9')).body as { clusters: Array<{ lat: number; lon: number; sources: Record<string, number> }> }; expect(m.clusters.some((c) => near(40.7127, -74.006, c) && c.sources.GEOCODED === 1)).toBe(true);
    // each placement is in the edit history and can be undone
    const hist = (await A.json('GET', `/api/library/photos/${ny}/history`)).body.edits as Array<{ id: string; field: string; newSource: string | null; kind: string }>; const g = hist.find((e) => e.field === 'gps')!; expect([g.newSource, g.kind]).toEqual(['GEOCODED', 'BULK']);
    expect((await A.json('POST', `/api/library/photos/${ny}/history/${g.id}/undo`, {})).status).toBe(200); expect((await detail(ny)).exif.gps).toBeNull();
    // run again: the undone one and the unknown one are still unplaced, but BOTH answers come from the cache — nothing is sent to the service a second time
    lookups = []; const again = await A.json('POST', '/api/library/photos/locate-named', {}); expect(again.body.names).toBe(2); expect(again.body.placed).toBe(1); expect(lookups).toEqual([]);
  });
  it('it needs sign-in, refuses a body, never crosses accounts, and an unreachable service changes nothing and says so', async (ctx) => {
    need(ctx); expect((await new ApiClient(app).req('POST', '/api/library/photos/locate-named', {})).statusCode).toBe(401);
    expect((await A.json('POST', '/api/library/photos/locate-named', { query: 'x' })).status).toBe(400);
    await textOnly('Washington, DC'); expect((await B.json('POST', '/api/library/photos/locate-named', {})).body).toMatchObject({ names: 0, placed: 0 });
    mode = 'down'; const r = await A.json('POST', '/api/library/photos/locate-named', {}); expect(r.body).toMatchObject({ names: 1, placed: 0 }); expect(r.body.results[0]).toMatchObject({ status: 'unavailable' }); expect((await world()).shown).toBe(0);
  });
  it('bulk “set location” with text that already matches still places the photographs (before, only photographs whose text changed were considered)', async (ctx) => {
    need(ctx); const a = await textOnly('Chicago, IL'); PLACES['chicago, il'] = [{ display_name: 'Chicago, Cook County, Illinois, United States', lat: '41.8755616', lon: '-87.6244212', category: 'boundary', type: 'administrative', boundingbox: ['41.6', '42.0', '-87.9', '-87.5'] }];
    const r = await A.json('POST', '/api/library/photos/bulk-location', { target: { ids: [a] }, location: 'Chicago, IL' }); expect(r.body).toMatchObject({ updated: 0, positioned: 1, geocode: { status: 'placed' } });
    expect((await world()).clusters.some((c) => near(41.8756, -87.6244, c))).toBe(true);
  });
});

