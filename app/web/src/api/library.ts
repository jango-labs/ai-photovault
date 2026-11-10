import { api } from './client';

/** Wire types of the Library API (server: app/server/src/library). Filtering, sorting and paging all happen in PostgreSQL. */
export const VIEWS = ['all', 'recent', 'favorites', 'rated', 'portfolio', 'published', 'never', 'unreviewed'] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABEL: Record<View, string> = {
  all: 'All photos', recent: 'Recently added', favorites: 'Favorites', rated: 'Rated', portfolio: 'Portfolio',
  published: 'Instagram published', never: 'Never published', unreviewed: 'Unreviewed',
};
export const SORTS = ['captured', 'imported', 'filename', 'rating', 'modified'] as const;
export type SortKey = (typeof SORTS)[number];
export const SORT_LABEL: Record<SortKey, string> = { captured: 'Date captured', imported: 'Date imported', filename: 'Filename', rating: 'Rating', modified: 'Recently modified' };
export type SortDir = 'asc' | 'desc';
export const DEFAULT_SORT: Record<View, { sort: SortKey; dir: SortDir }> = {
  all: { sort: 'captured', dir: 'desc' }, recent: { sort: 'imported', dir: 'desc' }, favorites: { sort: 'captured', dir: 'desc' }, rated: { sort: 'rating', dir: 'desc' },
  portfolio: { sort: 'captured', dir: 'desc' }, published: { sort: 'captured', dir: 'desc' }, never: { sort: 'captured', dir: 'desc' }, unreviewed: { sort: 'captured', dir: 'desc' },
};

export type IgFilter = 'posted' | 'never' | 'draft' | 'scheduled' | 'possible';
export type AiFilter = 'analyzed' | 'queued' | 'failed' | 'none';
export type Orientation = 'landscape' | 'portrait' | 'square';
export interface LibraryFilters {
  /** CAPTURE year (EXIF) — photographs without a capture time have none */
  year: number[]; folderYear: number[]; folder: string[]; month: number[]; location: string[]; city: string[]; state: string[]; country: string[]; rating: number[]; favorite?: boolean; portfolio?: boolean;
  ig: IgFilter[]; orientation: Orientation[]; camera: string[]; lens: string[]; ai: AiFilter[];
  /** true = only hidden photographs */
  hidden?: boolean;
  /** ['open'] = photographs that are in an unresolved near-duplicate pair */
  dup: Array<'open'>;
  /** west, south, east, north in degrees: only photographs with stored coordinates inside the box */
  bbox?: [number, number, number, number];
  /** where stored coordinates came from; 'none' = photographs without coordinates */
  gps: GpsFilter[];
}
export type GpsFilter = 'EXIF' | 'IPTC' | 'USER_DEFINED' | 'GEOCODED' | 'FOLDER_DERIVED' | 'AI_INFERRED' | 'none';
export const GPS_FILTERS: GpsFilter[] = ['EXIF', 'IPTC', 'USER_DEFINED', 'GEOCODED', 'FOLDER_DERIVED', 'AI_INFERRED', 'none'];
export const GPS_LABEL: Record<GpsFilter, string> = { EXIF: 'Camera (EXIF)', IPTC: 'File caption data (IPTC)', USER_DEFINED: 'Placed by you', GEOCODED: 'Approximate (centre of a place)', FOLDER_DERIVED: 'Folder name', AI_INFERRED: 'AI suggestion', none: 'No coordinates' };
export const bboxParam = (b: readonly number[]) => b.map((x) => Math.round(x * 1e6) / 1e6).join(',');
export function parseBbox(v: string | null): [number, number, number, number] | undefined {
  if (!v) return undefined;
  const n = v.split(',').map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[0]! >= -180 && n[2]! <= 180 && n[1]! >= -90 && n[3]! <= 90 && n[0]! <= n[2]! && n[1]! <= n[3]! ? (n as [number, number, number, number]) : undefined;
}
export interface LibraryQuery { view: View; sort: SortKey; dir: SortDir; q: string; filters: LibraryFilters }

export const emptyFilters = (): LibraryFilters => ({ year: [], folderYear: [], folder: [], month: [], location: [], city: [], state: [], country: [], rating: [], ig: [], orientation: [], camera: [], lens: [], ai: [], dup: [], gps: [] });
export const defaultQuery = (): LibraryQuery => ({ view: 'all', sort: 'captured', dir: 'desc', q: '', filters: emptyFilters() });
export const activeFilterCount = (f: LibraryFilters): number =>
  f.year.length + f.folderYear.length + f.folder.length + f.month.length + f.city.length + f.state.length + f.country.length + f.location.length + f.rating.length + f.ig.length + f.orientation.length + f.camera.length + f.lens.length + f.ai.length + (f.favorite !== undefined ? 1 : 0) + (f.portfolio !== undefined ? 1 : 0) + (f.hidden ? 1 : 0) + f.dup.length + f.gps.length + (f.bbox ? 1 : 0);

export interface PhotoCard {
  id: string; versionId: string; width: number; height: number; orientation: Orientation; title: string; filename: string;
  rating: number; favorite: boolean; portfolio: boolean; captureAt: string | null; captureOffset: string | null; year: number | null; folderYear: number | null; location: string | null; importedAt: string;
  ig: { state: 'NEVER_POSTED' | 'POSTED' | 'DRAFT' | 'SCHEDULED'; count: number; lastPostedAt: string | null; possibleDuplicate: boolean };
  ai: AiFilter; synthetic: boolean; dominant: string | null; duplicateOpen: boolean;
}
export interface PhotoPage { items: PhotoCard[]; nextCursor: string | null; total?: number }

export interface PhotoDetail {
  id: string; versionId: string; versionNo: number; versionCount: number; title: string; titleSource: string | null; filename: string; relativePath: string; sourcePresent: boolean;
  width: number; height: number; orientation: Orientation; bytes: number | null;
  captureAt: string | null; captureAtSource: string | null;
  /** the wall clock the camera wrote, without a zone ("2025-12-20T08:13:53.773"), and the UTC offset when known ("-07:00") */
  captureLocal: string | null; captureOffset: string | null; captureOffsetSource: string | null;
  year: number | null; folderYear: number | null; location: string | null; locationSource: string | null;
  place: { city: string | null; state: string | null; country: string | null; countryCode: string | null; sublocation: string | null; source: string | null }; colorLabel: string | null;
  importedAt: string; exportedAt: string | null; modifiedAt: string; rating: number; favorite: boolean; portfolio: boolean; notes: string | null; synthetic: boolean;
  description: string | null; descriptionSource: string | null; hidden: boolean;
  exif: {
    camera: string | null; lens: string | null; focalLengthMm: number | null; aperture: number | null; shutterSeconds: number | null; iso: number | null;
    copyright: string | null; photographer: string | null; keywords: string[]; keywordPaths: string[]; gps: { lat: number; lon: number; altitudeM: number | null; source: string; approximate: boolean; label: string | null } | null;
    /** the position the camera (or the file's caption data) recorded, kept even when a pin or a lookup is in use */
    cameraGps: { lat: number; lon: number; source: string; inUse: boolean } | null;
  };
  ig: PhotoCard['ig'];
  ai: {
    status: AiFilter;
    species: Array<{ name: string; scientific: string | null; confidence: number | null; status: string; source: string; behavior: string | null; habitat: string | null; count: number | null }>;
    analysis: { provider: string; model: string; mode: string; created_at: string; primary_subject: string | null; description: string | null; suggested_title: string | null; scenes: string[]; tags: string[]; scores: Record<string, number>; overall_score: number | null } | null;
  };
  collections: Array<{ id: string; name: string; kind: string }>;
  history: Array<{ id: string; posted_at: string; permalink: string | null; caption: string | null; state: string; score: number | null }>;
}

export interface Facet<T> { value: T; n: number }
export interface Facets { total: number; possibleDuplicates: number; openDuplicatePairs: number; years: Facet<number>[]; months: Facet<number>[]; folderYears: Facet<number>[]; folders: Facet<string>[]; locations: Facet<string>[]; countries: Facet<string>[]; cities: Facet<string>[]; cameras: Facet<string>[]; lenses: Facet<string>[] }
export interface LibraryPrefs { view: View; sort: SortKey; dir: SortDir; filters: Partial<LibraryFilters> }
export interface PhotoSet { rating?: number; favorite?: boolean; portfolio?: boolean; hidden?: boolean }

export const imageUrl = (id: string, size: 'thumb' | 'view' = 'thumb') => `/api/library/photos/${id}/image?size=${size}`;

/** Query string for GET /api/library/photos (repeated keys for lists; empty filters are omitted). */
export function toSearchParams(q: LibraryQuery, extra: { limit?: number; cursor?: string } = {}): URLSearchParams {
  const p = new URLSearchParams();
  if (q.view !== 'all') p.set('view', q.view);
  p.set('sort', q.sort); p.set('dir', q.dir);
  if (q.q.trim()) p.set('q', q.q.trim());
  const f = q.filters;
  for (const y of f.year) p.append('year', String(y));
  for (const y of f.folderYear) p.append('folderYear', String(y));
  for (const x of f.folder) p.append('folder', x);
  for (const m of f.month) p.append('month', String(m));
  for (const x of f.city) p.append('city', x);
  for (const x of f.state) p.append('state', x);
  for (const x of f.country) p.append('country', x);
  for (const x of f.location) p.append('location', x);
  for (const x of f.rating) p.append('rating', String(x));
  if (f.favorite !== undefined) p.set('favorite', String(f.favorite));
  if (f.portfolio !== undefined) p.set('portfolio', String(f.portfolio));
  if (f.hidden) p.set('hidden', 'true');
  for (const x of f.dup) p.append('dup', x);
  for (const x of f.ig) p.append('ig', x);
  for (const x of f.orientation) p.append('orientation', x);
  for (const x of f.camera) p.append('camera', x);
  for (const x of f.lens) p.append('lens', x);
  for (const x of f.ai) p.append('ai', x);
  for (const x of f.gps) p.append('gps', x);
  if (f.bbox) p.set('bbox', bboxParam(f.bbox));
  if (extra.limit) p.set('limit', String(extra.limit));
  if (extra.cursor) p.set('cursor', extra.cursor);
  return p;
}

const inSet = <T extends string>(xs: readonly T[], v: string | null): v is T => v !== null && (xs as readonly string[]).includes(v);
const nums = (xs: string[]) => xs.map(Number).filter((n) => Number.isInteger(n));
const bool = (v: string | null) => (v === 'true' ? true : v === 'false' ? false : undefined);

/** Inverse of toSearchParams (the URL is the shareable, refresh-proof state of the Library). Unknown or invalid values are ignored. */
export function fromSearchParams(p: URLSearchParams): LibraryQuery {
  const view = inSet(VIEWS, p.get('view')) ? (p.get('view') as View) : 'all';
  const d = DEFAULT_SORT[view];
  const sort = inSet(SORTS, p.get('sort')) ? (p.get('sort') as SortKey) : d.sort;
  const dir: SortDir = p.get('dir') === 'asc' || p.get('dir') === 'desc' ? (p.get('dir') as SortDir) : d.dir;
  return {
    view, sort, dir, q: (p.get('q') ?? '').slice(0, 120),
    filters: {
      year: nums(p.getAll('year')), folderYear: nums(p.getAll('folderYear')), folder: p.getAll('folder'), month: nums(p.getAll('month')).filter((n) => n >= 1 && n <= 12), city: p.getAll('city'), state: p.getAll('state'), country: p.getAll('country'), location: p.getAll('location'), rating: nums(p.getAll('rating')).filter((n) => n >= 0 && n <= 5),
      favorite: bool(p.get('favorite')), portfolio: bool(p.get('portfolio')), hidden: p.get('hidden') === 'true' ? true : undefined,
      dup: p.getAll('dup').filter((x): x is 'open' => x === 'open'),
      ig: p.getAll('ig').filter((x): x is IgFilter => ['posted', 'never', 'draft', 'scheduled', 'possible'].includes(x)),
      orientation: p.getAll('orientation').filter((x): x is Orientation => ['landscape', 'portrait', 'square'].includes(x)),
      camera: p.getAll('camera'), lens: p.getAll('lens'),
      ai: p.getAll('ai').filter((x): x is AiFilter => ['analyzed', 'queued', 'failed', 'none'].includes(x)),
      gps: p.getAll('gps').filter((x): x is GpsFilter => (GPS_FILTERS as string[]).includes(x)), bbox: parseBbox(p.get('bbox')),
    },
  };
}
/** Does the URL carry any Library state at all? (If not, the saved preferences apply.) */
export const hasLibraryParams = (p: URLSearchParams): boolean => ['view', 'sort', 'dir', 'q', 'year', 'folderYear', 'folder', 'month', 'city', 'state', 'country', 'location', 'rating', 'favorite', 'portfolio', 'hidden', 'dup', 'ig', 'orientation', 'camera', 'lens', 'ai', 'gps', 'bbox'].some((k) => p.has(k));

/** The body form of a query for bulk "select all matching": filters only (no sort/cursor). */
export function toFilterBody(q: LibraryQuery) {
  const f = q.filters;
  return {
    view: q.view, ...(q.q.trim() ? { q: q.q.trim() } : {}),
    ...(f.year.length ? { year: f.year } : {}), ...(f.folderYear.length ? { folderYear: f.folderYear } : {}), ...(f.folder.length ? { folder: f.folder } : {}), ...(f.month.length ? { month: f.month } : {}), ...(f.city.length ? { city: f.city } : {}), ...(f.state.length ? { state: f.state } : {}), ...(f.country.length ? { country: f.country } : {}), ...(f.location.length ? { location: f.location } : {}), ...(f.rating.length ? { rating: f.rating } : {}),
    ...(f.favorite !== undefined ? { favorite: f.favorite } : {}), ...(f.portfolio !== undefined ? { portfolio: f.portfolio } : {}),
    ...(f.hidden ? { hidden: true } : {}), ...(f.dup.length ? { dup: f.dup } : {}),
    ...(f.ig.length ? { ig: f.ig } : {}), ...(f.orientation.length ? { orientation: f.orientation } : {}), ...(f.camera.length ? { camera: f.camera } : {}),
    ...(f.lens.length ? { lens: f.lens } : {}), ...(f.ai.length ? { ai: f.ai } : {}), ...(f.gps.length ? { gps: f.gps } : {}), ...(f.bbox ? { bbox: f.bbox } : {}),
  };
}

export const fetchPhotos = (q: LibraryQuery, cursor?: string, limit = 120) => api<PhotoPage>('GET', `/api/library/photos?${toSearchParams(q, { limit, cursor })}`);
export const fetchFacets = () => api<Facets>('GET', '/api/library/facets');
export const fetchDetail = (id: string) => api<PhotoDetail>('GET', `/api/library/photos/${id}`);
export const patchPhoto = (id: string, set: PhotoSet) => api('PATCH', `/api/library/photos/${id}`, set);
export const bulkUpdate = (target: { ids: string[] } | { query: ReturnType<typeof toFilterBody>; exclude: string[] }, set: PhotoSet) =>
  api<{ updated: number }>('POST', '/api/library/photos/bulk', { target, set });
export const fetchPrefs = () => api<LibraryPrefs>('GET', '/api/library/preferences');
export const savePrefs = (p: LibraryPrefs) => api<LibraryPrefs>('PUT', '/api/library/preferences', p);

// ---------------------------------------------------------------- Phase 6: metadata, history, versions, duplicates, comparison
export interface MetaPatch {
  title?: string | null; description?: string | null; notes?: string | null; location?: string | null; captureAt?: string | null;
  /** a hand-placed pin; `approximate: true` marks the centre of a place chosen from a lookup */
  gps?: { lat: number; lon: number; approximate?: boolean; label?: string } | null;
  /** put the camera's own position back */ gpsRestore?: true;
  /** look the location text up on the map now, even if it did not change */ locate?: boolean;
}
export interface GeocodeInfo { status: 'placed' | 'cleared' | 'kept_exact' | 'not_found' | 'unavailable' | 'disabled'; query: string; label?: string; lat?: number; lon?: number; message?: string }
export interface GeoCandidate { label: string; lat: number; lon: number; kind: string; bbox: [number, number, number, number] | null }
export type GeocodeSearch = { enabled: boolean; attribution: string } & ({ status: 'ok'; candidates: GeoCandidate[]; cached: boolean } | { status: 'not_found'; cached: boolean } | { status: 'unavailable'; reason: string } | { status: 'disabled' });
export interface EditRow {
  id: string; photoId: string; batchId: string; field: 'title' | 'description' | 'notes' | 'capture_at' | 'trip_location' | 'gps' | 'current_version' | 'hidden';
  oldValue: unknown; newValue: unknown; oldSource: string | null; newSource: string | null; kind: 'EDIT' | 'UNDO' | 'BULK'; revertsId: string | null; editedAt: string; undone: boolean;
}
export interface VersionRow { id: string; versionNo: number; state: string; relativePath: string; sourcePresent: boolean; width: number | null; height: number | null; bytes: number | null; importedAt: string; exportedAt: string | null; sha256Prefix: string; derivStatus: string; current: boolean }
export interface PairView { id: string; distance: number; state: 'OPEN' | 'DUPLICATE' | 'DISTINCT'; detectedAt: string; a: PhotoCard; b: PhotoCard }

export const patchMetadata = (id: string, p: MetaPatch) => api<{ status: string; changed: string[]; batchId: string; geocode?: GeocodeInfo }>('PATCH', `/api/library/photos/${id}/metadata`, p);
/** place-name lookup (OpenStreetMap), only ever on an explicit request */
export interface LocateNamedResult { names: number; placed: number; results: Array<{ query: string; status: GeocodeInfo['status']; label?: string; photos: number; expected: number; message?: string }> }
/** put every photograph whose typed place name has no position yet on the map (one lookup per distinct name) */
export const locateNamed = () => api<LocateNamedResult>('POST', '/api/library/photos/locate-named', {});
export const geocodeSearch = (q: string) => api<GeocodeSearch>('GET', `/api/geocode?q=${encodeURIComponent(q)}`);
export const fetchHistory = (id: string) => api<{ edits: EditRow[] }>('GET', `/api/library/photos/${id}/history`).then((r) => r.edits);
export const undoEdit = (id: string, editId: string) => api('POST', `/api/library/photos/${id}/history/${editId}/undo`, {});
export const fetchVersions = (id: string) => api<{ versions: VersionRow[] }>('GET', `/api/library/photos/${id}/versions`).then((r) => r.versions);
export const restoreVersion = (id: string, versionId: string) => api<{ changed: boolean }>('POST', `/api/library/photos/${id}/versions/${versionId}/restore`, {});
export const fetchPhotoDuplicates = (id: string) => api<{ pairs: Array<PairView & { other: PhotoCard }> }>('GET', `/api/library/photos/${id}/duplicates`).then((r) => r.pairs);
export const fetchDuplicates = (state: PairView['state'], cursor?: string) => api<{ items: PairView[]; total: number; nextCursor: string | null }>('GET', `/api/library/duplicates?state=${state}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
export const scanDuplicates = (maxDistance?: number) => api<{ found: number; open: number }>('POST', '/api/library/duplicates/scan', maxDistance === undefined ? {} : { maxDistance });
export const decideDuplicate = (pairId: string, state: PairView['state']) => api('POST', `/api/library/duplicates/${pairId}`, { state });
export const fetchCompare = (ids: string[]) => api<{ photos: PhotoDetail[]; cards: PhotoCard[] }>('GET', `/api/library/compare?ids=${ids.join(',')}`);
export const bulkLocation = (target: { ids: string[] } | { query: ReturnType<typeof toFilterBody>; exclude: string[] }, location: string | null) =>
  api<{ updated: number; positioned: number; geocode?: GeocodeInfo }>('POST', '/api/library/photos/bulk-location', { target, location });
