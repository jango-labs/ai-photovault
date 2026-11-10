import type { Call, Reply, Routes } from './mockApi';
import type { Facets, PhotoCard, PhotoDetail } from '../api/library';

/** A stand-in for the Library API: pages through `total` synthetic cards. It does NOT filter — tests assert on what was *requested*, because the server does the filtering. */
export const fakeCard = (n: number): PhotoCard => {
  const dims: Array<[number, number]> = [[6000, 4000], [4000, 6000], [5000, 5000], [6000, 3375]];
  const [width, height] = dims[n % dims.length]!;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, versionId: `v-${n}`, width, height, orientation: width > height ? 'landscape' : height > width ? 'portrait' : 'square',
    title: `Photograph ${n}`, filename: `img_${n}.jpg`, rating: n % 6, favorite: n % 5 === 0, portfolio: n % 7 === 0, captureAt: '2025-06-01T08:00:00.000Z', captureOffset: null, year: 2025, folderYear: 2025,
    location: 'Kenya', importedAt: '2025-07-01T08:00:00.000Z', ig: { state: n % 8 === 0 ? 'POSTED' : 'NEVER_POSTED', count: n % 8 === 0 ? 1 : 0, lastPostedAt: null, possibleDuplicate: n % 11 === 0 },
    ai: 'none', synthetic: true, dominant: '#304050', duplicateOpen: n % 13 === 0,
  };
};
export const idOf = (n: number) => fakeCard(n).id;

export const FACETS: Facets = {
  total: 300, possibleDuplicates: 12, openDuplicatePairs: 4,
  years: [{ value: 2025, n: 200 }, { value: 2024, n: 100 }], months: [{ value: 6, n: 120 }, { value: 7, n: 80 }], folderYears: [{ value: 2025, n: 210 }, { value: 2024, n: 90 }], folders: [{ value: '2025/Kenya', n: 180 }, { value: '2025/Kenya/Day 2', n: 20 }, { value: '2024/Norway', n: 90 }], countries: [], cities: [], locations: [{ value: 'Kenya', n: 180 }, { value: 'Norway', n: 120 }],
  cameras: [{ value: 'Canon EOS R5', n: 150 }], lenses: [{ value: 'RF100-500mm F4.5-7.1 L IS USM', n: 90 }],
};

export const fakeDetail = (n: number): PhotoDetail => ({
  id: idOf(n), versionId: `v-${n}`, versionNo: 1, versionCount: 1, title: `Photograph ${n}`, titleSource: 'USER_DEFINED', filename: `img_${n}.jpg`, relativePath: `2025/Kenya/img_${n}.jpg`, sourcePresent: true,
  width: 6000, height: 4000, orientation: 'landscape', bytes: 9_000_000, captureAt: '2025-06-01T08:00:00.000Z', captureAtSource: 'EXIF', captureLocal: '2025-06-01T08:00:00.000', captureOffset: null, captureOffsetSource: null, year: 2025, folderYear: 2025, place: { city: null, state: null, country: null, countryCode: null, sublocation: null, source: null }, colorLabel: null, location: 'Kenya', locationSource: 'FOLDER_DERIVED',
  importedAt: '2025-07-01T08:00:00.000Z', exportedAt: null, modifiedAt: '2025-07-02T08:00:00.000Z', rating: n % 6, favorite: n % 5 === 0, portfolio: n % 7 === 0, notes: null, synthetic: true, description: null, descriptionSource: null, hidden: false,
  exif: { camera: 'Canon EOS R5', lens: 'RF100-500mm F4.5-7.1 L IS USM', focalLengthMm: 500, aperture: 7.1, shutterSeconds: 0.001, iso: 800, copyright: null, photographer: null, keywords: ['lion'], keywordPaths: [], gps: null, cameraGps: null },
  ig: { state: 'NEVER_POSTED', count: 0, lastPostedAt: null, possibleDuplicate: false }, ai: { status: 'none', species: [], analysis: null }, collections: [], history: [],
});

export interface LibraryFake { routes: Routes; photoCalls: Call[] }
/** `total` photographs; `pageOf` answers GET /api/library/photos from the cursor (an offset) and limit. */
export function libraryRoutes(total = 300, overrides: Routes = {}): LibraryFake {
  const photoCalls: Call[] = [];
  const photos = (c: Call): Reply => {
    photoCalls.push(c);
    const limit = Number(c.query.get('limit') ?? 120);
    const cursor = c.query.get('cursor');
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
    const n = Math.min(limit, total - offset);
    const items = Array.from({ length: Math.max(0, n) }, (_, i) => fakeCard(offset + i));
    const next = offset + n < total ? Buffer.from(String(offset + n)).toString('base64url') : null;
    return { json: { items, nextCursor: next, ...(cursor ? {} : { total }) } };
  };
  const routes: Routes = {
    'GET /api/library/preferences': { json: { view: 'all', sort: 'captured', dir: 'desc', filters: {} } },
    'PUT /api/library/preferences': (c) => ({ json: c.body }),
    'GET /api/library/photos': photos,
    'GET /api/library/facets': { json: FACETS },
    '~GET /api/ai/photos/[^/]+': { json: { currentVersionId: 'v', queued: false, analyses: [], species: [], corrections: [] } },
    '~GET /api/library/photos/[^/]+/history': { json: { edits: [] } },
    '~GET /api/library/photos/[^/]+/versions': { json: { versions: [] } },
    '~GET /api/library/photos/[^/]+/duplicates': { json: { pairs: [] } },
    ...overrides,
  };
  return { routes, photoCalls };
}
