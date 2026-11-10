import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { Geocoder, geocoderConfigFromEnv, normaliseQuery, type GeocoderConfig } from './geocoder.js';

let h: Handles | null; let uid = ''; let other = '';
beforeAll(async () => { h = await tryHandles(); if (!h) return; await wipe(h.svc); uid = await makeUser(h.svc, 'geo1@example.test'); other = await makeUser(h.svc, 'geo2@example.test'); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

/** Nominatim-shaped answers for the places the owner asked about */
const DC = { display_name: 'Washington, District of Columbia, United States', lat: '38.8950982', lon: '-77.0363849', category: 'place', type: 'city', boundingbox: ['38.7916303', '38.9959680', '-77.1197949', '-76.9093660'] };
const NYC = { display_name: 'New York, United States', lat: '40.7127281', lon: '-74.0060152', category: 'boundary', type: 'administrative', boundingbox: ['40.4765780', '40.9176300', '-74.2588430', '-73.7002330'] };
const YELLOW = { display_name: 'Yellowstone National Park, Wyoming, United States', lat: '44.6200885', lon: '-110.5606893', category: 'leisure', type: 'nature_reserve', boundingbox: ['44.1315750', '45.1089567', '-111.1559859', '-109.8254870'] };
const ANSWERS: Record<string, unknown[]> = { 'washington, dc': [DC], 'new york, ny': [NYC], 'yellowstone national park': [YELLOW], 'nowhere zz': [] };
interface Seen { url: URL; ua: string | undefined; at: number }
function fake(over: Partial<GeocoderConfig> = {}, behave?: (q: string) => Response | Promise<Response>) {
  const seen: Seen[] = []; let t = 1_000_000; const slept: number[] = [];
  const cfg: GeocoderConfig = { ...geocoderConfigFromEnv({ PHOTOVAULT_GEOCODER: 'on' }), baseUrl: 'https://nominatim.test', minIntervalMs: 1100, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    fetch: (async (u: URL, init: RequestInit) => { const url = new URL(String(u)); seen.push({ url, ua: (init.headers as Record<string, string>)['user-agent'], at: t }); const q = url.searchParams.get('q')!.toLowerCase();
      if (behave) return behave(q); return new Response(JSON.stringify(ANSWERS[q] ?? []), { status: 200 }); }) as typeof fetch, ...over };
  return { g: new Geocoder(h!.app, cfg), seen, slept, tick: (ms: number) => { t += ms; } };
}

describe('place-name lookup (OpenStreetMap Nominatim; a fake transport stands in for the network)', () => {
  it('resolves the three places the owner named to the centre of each place, with a label and a box, as a candidate list', async (ctx) => {
    need(ctx); const { g } = fake();
    const dc = await g.lookup(uid, 'Washington, DC'); expect(dc).toMatchObject({ status: 'ok', cached: false });
    if (dc.status === 'ok') { const c = dc.candidates[0]!; expect(c).toMatchObject({ label: 'Washington, District of Columbia, United States', lat: 38.8950982, lon: -77.0363849, kind: 'place/city' }); expect(c.bbox!.map((x) => Math.round(x * 1000) / 1000)).toEqual([-77.12, 38.792, -76.909, 38.996]); }   // [west, south, east, north]
    const ny = await g.lookup(uid, 'New York, NY'); expect(ny.status === 'ok' && ny.candidates[0]!.lat).toBeCloseTo(40.7127, 3);
    const ys = await g.lookup(uid, 'Yellowstone National Park'); expect(ys.status === 'ok' && ys.candidates[0]!.lon).toBeCloseTo(-110.5607, 3);
  });
  it('follows the usage policy: an identifying User-Agent, only the typed text is sent, requests are at least 1.1 s apart even when issued together', async (ctx) => {
    need(ctx); await h!.svc`DELETE FROM geocode_cache`; const { g, seen, slept } = fake();
    await Promise.all([g.lookup(uid, 'Washington, DC'), g.lookup(uid, 'New York, NY'), g.lookup(uid, 'Yellowstone National Park')]);
    expect(seen).toHaveLength(3); for (const s of seen) { expect(s.ua).toMatch(/^AIPhotoVault\//); expect(s.ua).not.toMatch(/node|undici/i); expect([...s.url.searchParams.keys()].sort()).toEqual(['accept-language', 'addressdetails', 'format', 'limit', 'q']); }
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.at - seen[i - 1]!.at).toBeGreaterThanOrEqual(1100); expect(slept.length).toBeGreaterThan(0);
  });
  it('caches: the same text (any case or spacing) is not sent twice; "not found" is cached too; another account does not share the cache', async (ctx) => {
    need(ctx); await h!.svc`DELETE FROM geocode_cache`; const { g, seen } = fake();
    await g.lookup(uid, 'Washington, DC'); const again = await g.lookup(uid, '  washington,   DC '); expect(again).toMatchObject({ status: 'ok', cached: true }); expect(seen).toHaveLength(1);
    expect(await g.lookup(uid, 'nowhere zz')).toMatchObject({ status: 'not_found', cached: false }); expect(await g.lookup(uid, 'Nowhere ZZ')).toMatchObject({ status: 'not_found', cached: true }); expect(seen).toHaveLength(2);
    await g.lookup(other, 'Washington, DC'); expect(seen).toHaveLength(3);
    expect(normaliseQuery('  New   York,  NY ')).toBe('new york, ny');
  });
  it('a service that is down, slow, throttling or gibberish gives a status — never an exception, never a cache entry', async (ctx) => {
    need(ctx); await h!.svc`DELETE FROM geocode_cache`;
    expect(await fake({}, () => new Response('slow down', { status: 429 })).g.lookup(uid, 'Washington, DC')).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/slow down/) });
    expect(await fake({}, () => new Response('oops', { status: 503 })).g.lookup(uid, 'Washington, DC')).toMatchObject({ status: 'unavailable' });
    expect(await fake({}, () => new Response('{"not":"a list"}', { status: 200 })).g.lookup(uid, 'Washington, DC')).toMatchObject({ status: 'unavailable' });
    expect(await fake({}, () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ENOTFOUND nominatim.test') }); }).g.lookup(uid, 'Washington, DC')).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/could not be reached/) });
    expect(Number((await h!.svc`SELECT count(*)::int AS n FROM geocode_cache`)[0]!.n)).toBe(0);
  });
  it('ignores impossible coordinates, can be switched off, and refuses a plain-http remote service', async (ctx) => {
    need(ctx); const bad = fake({}, () => new Response(JSON.stringify([{ display_name: 'x', lat: '95', lon: '10', category: 'place', type: 'city' }, { display_name: 'y', lat: 'abc', lon: '1' }]), { status: 200 }));
    expect(await bad.g.lookup(uid, 'impossible place')).toMatchObject({ status: 'not_found' });
    const off = fake({ enabled: false }); expect(await off.g.lookup(uid, 'Washington, DC')).toEqual({ status: 'disabled' }); expect(off.seen).toHaveLength(0);
    expect(() => new Geocoder(h!.app, { ...geocoderConfigFromEnv({ PHOTOVAULT_GEOCODER: 'on' }), baseUrl: 'http://example.com' })).toThrow(/HTTPS/);
  });
});
