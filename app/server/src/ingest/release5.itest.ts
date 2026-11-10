import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { IngestService } from './service.js';
import { makeJpeg, type FakeJpeg } from './testkit.js';

/**
 * Release 5 metadata: capture year ≠ folder year (D1), partial camera/lens search (D2), IPTC places (D3), time-zone offsets (D4) and the Lightroom fields.
 * Every photograph here is a SYNTHETIC fixture built in a temporary folder.
 */
let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let uid: string; let src: string; let deriv: string;
const dirs: string[] = [];
const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-r5-'))); dirs.push(d); return d; };
const put = (rel: string, o: FakeJpeg = {}) => makeJpeg(path.join(src, rel), { width: 320, height: 214, pattern: rel.length * 7 + (o.pattern ?? 0), ...o });
const ing = () => new IngestService({ sql: h!.app, policy: { approved: [{ path: src, modes: ['DRY_RUN', 'APPLY'], approvedAt: 'test' }] }, derivativesDir: deriv, heartbeatMs: 10 });
const q = async <T extends object>(text: string): Promise<T[]> => (await h!.svc.unsafe(text)) as unknown as T[];
const names = async (qs: string) => ((await A.json('GET', `/api/library/photos?limit=300&sort=captured&dir=asc&${qs}`)).body.items as Array<{ filename: string }>).map((i) => i.filename);
const found = async (text: string) => ((await A.json('GET', `/api/search?q=${encodeURIComponent(text)}&limit=100`)).body.items as Array<{ filename: string }>).map((i) => i.filename).sort();
const detail = async (file: string) => { const list = (await A.json('GET', '/api/library/photos?limit=300')).body.items as Array<{ id: string; filename: string }>; return (await A.json('GET', `/api/library/photos/${list.find((i) => i.filename === file)!.id}`)).body; };

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); uid = await makeUser(h.svc, 'r5@example.test'); src = mk(); deriv = mk(); app = makeApp(h, { derivativesDir: deriv }); A = await new ApiClient(app).signIn('r5@example.test');
  // D1: folder year and capture year differ; an undated photograph in a year folder
  await put('2026/DC/dc_2025_summer.jpg', { captureAt: '2025:07:27 22:29:52', subsec: '586' });
  await put('2024/Mexico/mex_nov.jpg', { captureAt: '2025:11:04 06:51:40', subsec: '547' });
  await put('2025/Kenya/undated.jpg');
  await put('2025/Kenya/old_2022.jpg', { captureAt: '2022:05:06 17:12:11' });
  // D4: offsets, and a wall clock that is a different year from its instant
  await put('2025/Montana/late_dec.jpg', { captureAt: '2025:12:31 23:30:00', subsec: '100', offset: '-07:00' });
  await put('2026/Tokyo/early_jan.jpg', { captureAt: '2026:01:01 00:10:00', subsec: '200', offset: '+09:00' });
  await put('2026/Lima/no_offset.jpg', { captureAt: '2026:03:03 10:00:00', subsec: '300' });
  await put('2026/Lima/xmp_offset.jpg', { captureAt: '2026:03:04 08:00:00', subsec: '400', xmp: { dateCreated: '2026-03-04T08:00:00-05:00' } });
  await put('2026/Lima/xmp_offset_other_clock.jpg', { captureAt: '2026:03:05 08:00:00', subsec: '500', xmp: { dateCreated: '2026-03-05T20:00:00-05:00' } });
  // D3: IPTC places, with and without GPS
  await put('2026/India/mumbai.jpg', { captureAt: '2022:05:06 17:12:11', iptc: { city: 'Mumbai', state: 'Maharashtra', country: 'India', countryCode: 'IN', sublocation: 'Colaba' } });
  await put('2026/India/gps_only.jpg', { captureAt: '2022:05:07 10:00:00', gps: { lat: 19.0, lon: 72.8 } });
  await put('2026/India/place_xmp_only.jpg', { captureAt: '2022:05:08 10:00:00', xmp: { city: 'Pune', state: 'Maharashtra', country: 'India', countryCode: 'IN' } });
  // D2: cameras and lenses
  await put('2025/Cams/cam_a.jpg', { captureAt: '2025:02:17 08:19:17', make: 'SONY', model: 'ILCE-7RM5', lens: 'FE 70-200mm F2.8 GM OSS II' });
  await put('2025/Cams/cam_b.jpg', { captureAt: '2025:12:20 08:13:53', make: 'Apple', model: 'iPhone 17 Pro', lens: 'iPhone 17 Pro back triple camera 6.765mm f/1.78' });
  await put('2026/Trips/state_only.jpg', { captureAt: '2024:08:01 10:00:00', iptc: { state: 'Montana', country: 'United States', countryCode: 'US' } });          // a place word that is a folder name for one photograph and an IPTC state for another
  // Lightroom fields
  await put('2025/LR/bison.jpg', { captureAt: '2025:12:20 09:00:00', artist: 'Sample Photographer', gps: { lat: 44.66, lon: -111.1, alt: 2032.85 },
    iptc: { keywords: ['bison'], title: 'Bison at dawn', caption: 'A bison in snow', byline: 'Sample Photographer' }, xmp: { subject: ['bison', 'winter'], hierarchical: ['Wildlife|Mammals|Bison'], rating: 4, label: 'Green' } });
  await put('2025/LR/xmp_only.jpg', { captureAt: '2025:12:21 09:00:00', xmp: { title: 'XMP title', description: 'XMP caption', creator: 'Sample Photographer', rights: '© Sample Photographer', subject: ['marsh'] } });
  await put('2025/LR/below_sea.jpg', { captureAt: '2025:12:22 09:00:00', gps: { lat: 31.5, lon: 35.5, alt: -430.4 } });
  await put('2025/LR/bare.jpg', { color: { r: 10, g: 200, b: 30 } });
  const run = await ing().run(uid, src, 'APPLY'); if (process.env.DEBUG_R5) console.log(JSON.stringify(run.counters), JSON.stringify(await q('SELECT source_relpath FROM photo_versions ORDER BY 1')));
}, 120_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('D1 — capture year and folder year are separate; undated photographs stay undated', () => {
  it('stores the folder year and the capture year apart, and never gives an undated photograph a year', async (ctx) => {
    need(ctx);
    const rows = await q<{ f: string; year: number | null; capture_year: number | null; capture_month: number | null; capture_at: Date | null }>(`SELECT regexp_replace(v.source_relpath, '^.*/', '') AS f, p.year, p.capture_year, p.capture_month, p.capture_at FROM photos p JOIN photo_versions v ON v.id = p.current_version_id`);
    const by = Object.fromEntries(rows.map((r) => [r.f, r]));
    expect(by['dc_2025_summer.jpg']).toMatchObject({ year: 2026, capture_year: 2025, capture_month: 7 });
    expect(by['mex_nov.jpg']).toMatchObject({ year: 2024, capture_year: 2025, capture_month: 11 });
    expect(by['undated.jpg']).toMatchObject({ year: 2025, capture_year: null, capture_month: null, capture_at: null });
    expect(by['bare.jpg']).toMatchObject({ year: 2025, capture_year: null });
  });
  it('the year filter, the year facet and year words in search use the CAPTURE time; the folder year has its own filter and facet', async (ctx) => {
    need(ctx);
    expect(await names('year=2025&month=11')).toEqual(['mex_nov.jpg']);
    expect(await names('year=2025&month=7')).toEqual(['dc_2025_summer.jpg']);
    expect(await names('folderYear=2026&location=DC')).toEqual(['dc_2025_summer.jpg']);
    expect(await names('year=2026&location=DC')).toEqual([]);                                // nothing in the DC folder was shot in 2026
    const undatedInYear = await names('year=2025'); expect(undatedInYear).not.toContain('undated.jpg'); expect(undatedInYear).toContain('mex_nov.jpg');
    expect(await names('folderYear=2025&location=Kenya')).toEqual(['old_2022.jpg', 'undated.jpg']);                    // dated photograph first, undated last
    const f = (await A.json('GET', '/api/library/facets')).body;
    const yearMap = Object.fromEntries(f.years.map((y: { value: number; n: number }) => [y.value, y.n]));
    expect(yearMap[2025]).toBeGreaterThanOrEqual(4); expect(yearMap[2022]).toBeGreaterThanOrEqual(1);
    expect(f.folderYears.map((y: { value: number }) => y.value)).toEqual(expect.arrayContaining([2026, 2025, 2024]));
    expect(f.years.reduce((a: number, y: { n: number }) => a + y.n, 0)).toBe(f.total - 2);        // the two photographs without a capture time are in no year
    const viaSearch = await found('photos from 2025 november'); expect(viaSearch).toEqual(['mex_nov.jpg']);
    const parsed = (await A.json('GET', '/api/search?q=2025')).body; expect(parsed.items.map((i: { filename: string }) => i.filename)).not.toContain('undated.jpg');
  });
  it('cards and detail carry both years; the folder structure is still browsable', async (ctx) => {
    need(ctx);
    const d = await detail('dc_2025_summer.jpg');
    expect(d).toMatchObject({ year: 2025, folderYear: 2026, location: 'DC', relativePath: '2026/DC/dc_2025_summer.jpg' });
    const u = await detail('undated.jpg'); expect(u).toMatchObject({ year: null, folderYear: 2025, captureAt: null, captureLocal: null, captureOffset: null });
    const fac = (await A.json('GET', '/api/library/facets')).body; expect(fac.locations.map((l: { value: string }) => l.value)).toEqual(expect.arrayContaining(['DC', 'Mexico', 'Kenya', 'Tokyo']));
  });
});

describe('D4 — capture instant, UTC offset and local wall clock', () => {
  it('stores the original EXIF text, the offset and the true instant; the local wall clock decides year and month', async (ctx) => {
    need(ctx);
    const late = await detail('late_dec.jpg');
    expect(late).toMatchObject({ captureOffset: '-07:00', captureOffsetSource: 'EXIF', captureLocal: '2025-12-31T23:30:00.100', captureAt: '2026-01-01T06:30:00.100Z', year: 2025 });
    const tokyo = await detail('early_jan.jpg');
    expect(tokyo).toMatchObject({ captureOffset: '+09:00', captureLocal: '2026-01-01T00:10:00.200', captureAt: '2025-12-31T15:10:00.200Z', year: 2026 });
    expect(await names('year=2025&month=12')).toContain('late_dec.jpg'); expect(await names('year=2026&month=1')).toEqual(['early_jan.jpg']);
    const raw = await q<{ exif: Record<string, string> }>(`SELECT v.exif FROM photo_versions v WHERE v.source_relpath LIKE '%late_dec.jpg'`);
    expect(raw[0]!.exif).toMatchObject({ DateTimeOriginal: '2025:12:31 23:30:00', OffsetTimeOriginal: '-07:00', SubSecTimeOriginal: '100' });      // the original values are preserved untouched
  });
  it('chronological order follows the true instant across different offsets', async (ctx) => {
    need(ctx);
    const order = (await names('')).filter((n) => ['late_dec.jpg', 'early_jan.jpg'].includes(n));
    expect(order).toEqual(['early_jan.jpg', 'late_dec.jpg']);                                   // Tokyo 00:10 on 1 Jan is EARLIER than Montana 23:30 on 31 Dec
    const desc = ((await A.json('GET', '/api/library/photos?limit=300&sort=captured&dir=desc')).body.items as Array<{ filename: string }>).map((i) => i.filename).filter((n) => ['late_dec.jpg', 'early_jan.jpg'].includes(n));
    expect(desc).toEqual(['late_dec.jpg', 'early_jan.jpg']);
  });
  it('a file without an offset keeps the wall clock as written and says the offset is unknown; XMP/IPTC offsets are used only when they describe the same moment', async (ctx) => {
    need(ctx);
    expect(await detail('no_offset.jpg')).toMatchObject({ captureOffset: null, captureOffsetSource: null, captureLocal: '2026-03-03T10:00:00.300', captureAt: '2026-03-03T10:00:00.300Z' });
    expect(await detail('xmp_offset.jpg')).toMatchObject({ captureOffset: '-05:00', captureOffsetSource: 'XMP', captureLocal: '2026-03-04T08:00:00.400', captureAt: '2026-03-04T13:00:00.400Z' });
    expect(await detail('xmp_offset_other_clock.jpg')).toMatchObject({ captureOffset: null, captureOffsetSource: null, captureLocal: '2026-03-05T08:00:00.500' });
  });
  it('a manual date edit keeps its typed offset, and undo restores the earlier time AND offset exactly', async (ctx) => {
    need(ctx);
    const d = await detail('late_dec.jpg');
    const r = await A.json('PATCH', `/api/library/photos/${d.id}/metadata`, { captureAt: '2025-06-01T10:00:00+02:00' }); expect(r.status).toBe(200);
    expect(await detail('late_dec.jpg')).toMatchObject({ captureOffset: '+02:00', captureLocal: '2025-06-01T10:00:00.000', captureAt: '2025-06-01T08:00:00.000Z', year: 2025, folderYear: 2025, captureOffsetSource: 'USER_DEFINED' });
    const hist = (await A.json('GET', `/api/library/photos/${d.id}/history`)).body.edits as Array<{ id: string; field: string }>;
    expect((await A.json('POST', `/api/library/photos/${d.id}/history/${hist.find((e) => e.field === 'capture_at')!.id}/undo`)).status).toBe(200);
    expect(await detail('late_dec.jpg')).toMatchObject({ captureOffset: '-07:00', captureLocal: '2025-12-31T23:30:00.100', captureAt: '2026-01-01T06:30:00.100Z' });
  });
});

describe('browsing by the original folder structure', () => {
  it('lists every folder with its count and shows everything inside a chosen folder at any depth; the folder filter is safe', async (ctx) => {
    need(ctx);
    const f = (await A.json('GET', '/api/library/facets')).body; const dirs = Object.fromEntries(f.folders.map((d: { value: string; n: number }) => [d.value, d.n]));
    expect(dirs['2026/DC']).toBe(1); expect(dirs['2024/Mexico']).toBe(1); expect(dirs['2025/Cams']).toBe(2); expect(Object.keys(dirs)).not.toContain('2025');      // directories only (a year folder holds no files directly)
    expect(await names('folder=2026/DC')).toEqual(['dc_2025_summer.jpg']); expect(await names('folder=2025')).toEqual(expect.arrayContaining(['cam_a.jpg', 'cam_b.jpg', 'undated.jpg', 'late_dec.jpg']));
    expect((await names('folder=2025/Cams')).sort()).toEqual(['cam_a.jpg', 'cam_b.jpg']); expect(await names('folder=2025/Cam')).toEqual([]);                                         // a prefix of a name is not a folder
    expect(await names('folder=2025/Kenya&folder=2026/DC')).toHaveLength(3);
    expect(await names('folder=%25')).toEqual([]); expect(await names('folder=2025/_ams')).toEqual([]);                                                                          // LIKE wildcards are literal
    expect((await A.json('GET', '/api/library/photos?folder=../etc')).status).toBe(400); expect((await A.json('GET', '/api/library/photos?folder=/abs')).status).toBe(400);
    expect(f.months.find((m: { value: number }) => m.value === 12)).toMatchObject({ n: expect.any(Number) });
  });
});

describe('D3 — IPTC / XMP places', () => {
  it('stores city, state, country, country code and sublocation, independent of GPS and of the folder', async (ctx) => {
    need(ctx);
    expect((await detail('mumbai.jpg'))).toMatchObject({ place: { city: 'Mumbai', state: 'Maharashtra', country: 'India', countryCode: 'IN', sublocation: 'Colaba', source: 'IPTC' }, location: 'India' });
    expect((await detail('mumbai.jpg')).exif.gps).toBeNull();                                      // a place name does not invent coordinates
    const g = await detail('gps_only.jpg'); expect(g.place).toMatchObject({ city: null, country: null }); expect(g.exif.gps).toMatchObject({ lat: 19, lon: 72.8, source: 'EXIF' });
    expect((await detail('place_xmp_only.jpg')).place).toMatchObject({ city: 'Pune', state: 'Maharashtra', countryCode: 'IN' });   // XMP-only places count too
  });
  it('a place word finds both the folder and the IPTC place names', async (ctx) => {
    need(ctx);
    expect(await found('Montana')).toEqual(['late_dec.jpg', 'state_only.jpg']);                    // late_dec sits in a folder called Montana; state_only carries the IPTC state
    expect(await found('united states')).toEqual(['state_only.jpg']);
  });
  it('is filterable (case-insensitive; the country by name or code) and searchable in words', async (ctx) => {
    need(ctx);
    expect(await names('city=MUMBAI')).toEqual(['mumbai.jpg']); expect(await names('city=pune&city=mumbai')).toEqual(['mumbai.jpg', 'place_xmp_only.jpg']);
    expect(await names('state=maharashtra')).toEqual(['mumbai.jpg', 'place_xmp_only.jpg']); expect(await names('country=in')).toEqual(['mumbai.jpg', 'place_xmp_only.jpg']); expect(await names('country=india')).toEqual(['mumbai.jpg', 'place_xmp_only.jpg']);
    expect(await found('Mumbai')).toEqual(['mumbai.jpg']); expect(await found('colaba')).toEqual(['mumbai.jpg']); expect(await found('maharashtra')).toEqual(['mumbai.jpg', 'place_xmp_only.jpg']);
    const f = (await A.json('GET', '/api/library/facets')).body; expect(f.countries).toEqual([{ value: 'India', n: 2 }, { value: 'United States', n: 1 }]); expect(f.cities.map((c: { value: string }) => c.value).sort()).toEqual(['Mumbai', 'Pune']);
  });
});

describe('D2 — partial, case-insensitive camera and lens search', () => {
  it('finds cameras and lenses by any word or fragment, and the exact label still works', async (ctx) => {
    need(ctx);
    for (const t of ['sony', 'SONY', 'ilce', 'ILCE-7RM5', '70-200', '70-200mm', 'gm oss']) expect(await found(t), t).toEqual(['cam_a.jpg']);
    for (const t of ['iphone', 'iPhone 17', 'apple', 'triple camera', '6.765mm']) expect(await found(t), t).toEqual(['cam_b.jpg']);
    expect(await found('Sony ILCE-7RM5')).toEqual(['cam_a.jpg']);                                   // exact label (a camera filter) still works
    expect(await names('camera=SONY%20ILCE-7RM5')).toEqual(['cam_a.jpg']); expect(await names('q=ilce')).toEqual(['cam_a.jpg']); expect(await names('q=IPHONE')).toEqual(['cam_b.jpg']);
    expect(await found('nikon')).toEqual([]);
  });
});

describe('Lightroom metadata', () => {
  it('imports keywords (flat and hierarchical), title, caption, creator, copyright, rating, colour label and GPS altitude; XMP-only fields count', async (ctx) => {
    need(ctx);
    const b = await detail('bison.jpg');
    expect(b).toMatchObject({ title: 'Bison at dawn', description: 'A bison in snow', rating: 4, colorLabel: 'Green', exif: { photographer: 'Sample Photographer' } });
    expect(b.exif.keywords).toEqual(expect.arrayContaining(['bison', 'winter', 'Bison'])); expect(b.exif.keywordPaths).toEqual(['Wildlife|Mammals|Bison']);
    expect(b.exif.gps).toMatchObject({ lat: 44.66, lon: -111.1, altitudeM: 2032.9, source: 'EXIF' });
    const x = await detail('xmp_only.jpg'); expect(x).toMatchObject({ title: 'XMP title', description: 'XMP caption', exif: { photographer: 'Sample Photographer', copyright: '© Sample Photographer', keywords: ['marsh'] } });
    expect((await detail('below_sea.jpg')).exif.gps.altitudeM).toBe(-430.4);
  });
  it('is searchable and filterable: hierarchical keyword words, colour label', async (ctx) => {
    need(ctx);
    expect(await found('mammals')).toEqual(['bison.jpg']); expect(await found('wildlife')).toEqual(['bison.jpg']); expect(await found('marsh')).toEqual(['xmp_only.jpg']);
    expect(await names('label=green')).toEqual(['bison.jpg']); expect(await names('rating=4')).toEqual(['bison.jpg']);
  });
  it('handles missing metadata gracefully', async (ctx) => {
    need(ctx);
    const d = await detail('bare.jpg');
    expect(d).toMatchObject({ captureAt: null, captureLocal: null, captureOffset: null, year: null, colorLabel: null, rating: 0, place: { city: null, state: null, country: null, countryCode: null, sublocation: null }, exif: { camera: null, lens: null, keywords: [], keywordPaths: [], gps: null, photographer: null, copyright: null } });
  });
  it('a re-import changes nothing, and never overrides a rating the photographer has set', async (ctx) => {
    need(ctx);
    const b = await detail('bison.jpg'); await A.json('PATCH', `/api/library/photos/${b.id}`, { rating: 2 });
    const run = await ing().run(uid, src, 'APPLY'); expect(run.counters).toMatchObject({ new: 0, unchanged: 19, errors: 0 });
    expect((await detail('bison.jpg')).rating).toBe(2);
  });
});
