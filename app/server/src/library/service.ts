import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import {
  FiltersSchema, afterCursor, cameraLabel, decodeCursor, encodeCursor, orderBy, whereFor, SORT_DEFS,
  type Filters, type ListParams,
} from './query.js';

export type IgState = 'NEVER_POSTED' | 'POSTED' | 'DRAFT' | 'SCHEDULED';
export type AiStatus = 'analyzed' | 'queued' | 'failed' | 'none';
export type Orientation = 'landscape' | 'portrait' | 'square';

/** What the grid needs to draw one photograph. Deliberately small: a page of 120 is ~35 KB. */
export interface PhotoCard {
  id: string; versionId: string; width: number; height: number; orientation: Orientation;
  title: string; filename: string; rating: number; favorite: boolean; portfolio: boolean;
  captureAt: string | null; captureOffset: string | null;
  /** CAPTURE year (null when the photograph has no EXIF capture time) and the FOLDER year, kept apart */
  year: number | null; folderYear: number | null; location: string | null; importedAt: string;
  ig: { state: IgState; count: number; lastPostedAt: string | null; possibleDuplicate: boolean };
  ai: AiStatus; synthetic: boolean; dominant: string | null; duplicateOpen: boolean;
}
export interface PhotoPage { items: PhotoCard[]; nextCursor: string | null; total?: number }

export const orientationOf = (w: number, h: number): Orientation => (w > h * 1.03 ? 'landscape' : h > w * 1.03 ? 'portrait' : 'square');
const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

interface ListRow {
  id: string; version_id: string; width: number; height: number; title: string | null; relpath: string; rating: number; favorite: boolean;
  portfolio: boolean; capture_at: Date | null; capture_offset_min: number | null; year: number | null; folder_year: number | null; location: string | null; ingested_at: Date; exif_synth: string | null; dominant: string | null; sort_key: string | null;
}
interface EnrichRow { id: string; posted_count: number; last_posted_at: Date | null; has_draft: boolean; has_scheduled: boolean; possible: boolean; ai: AiStatus; dup: boolean }

/** minutes east of UTC → "+05:30" / "-07:00" */
export const offsetText = (m: number | null): string | null => (m === null || m === undefined ? null : `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`);
const filenameOf = (relpath: string) => relpath.slice(relpath.lastIndexOf('/') + 1);

/** Second query for the ≤300 photographs on a page: Instagram state, possible duplicates and AI status (kept out of the sorted/filtered scan). */
async function enrich(tx: Sql, ids: string[]): Promise<Map<string, EnrichRow>> {
  if (!ids.length) return new Map();
  const rows = await tx<EnrichRow[]>`
    SELECT p.id, coalesce(s.posted_count, 0)::int AS posted_count, s.last_posted_at, coalesce(s.has_draft, false) AS has_draft, coalesce(s.has_scheduled, false) AS has_scheduled,
           EXISTS (SELECT 1 FROM photo_social_matches m WHERE m.user_id = p.user_id AND m.photo_id = p.id AND m.state = 'POSSIBLE_MATCH') AS possible,
           EXISTS (SELECT 1 FROM duplicate_pairs d WHERE d.user_id = p.user_id AND d.state = 'OPEN' AND (d.photo_a = p.id OR d.photo_b = p.id)) AS dup,
           CASE WHEN EXISTS (SELECT 1 FROM ai_analyses a WHERE a.user_id = p.user_id AND a.photo_version_id = p.current_version_id) THEN 'analyzed'
                WHEN EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = p.user_id AND j.kind = 'ai.analyze' AND j.payload ->> 'photoId' = p.id::text AND j.state IN ('QUEUED','RUNNING')) THEN 'queued'
                WHEN EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = p.user_id AND j.kind = 'ai.analyze' AND j.payload ->> 'photoId' = p.id::text AND j.state IN ('FAILED','DEAD')) THEN 'failed'
                ELSE 'none' END AS ai
      FROM photos p LEFT JOIN photo_instagram_status s ON s.photo_id = p.id
     WHERE p.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

function mapCard(r: ListRow, e: EnrichRow | undefined): PhotoCard {
  const file = filenameOf(r.relpath);
  return {
    id: r.id, versionId: r.version_id, width: r.width, height: r.height, orientation: orientationOf(r.width, r.height),
    title: r.title ?? file, filename: file, rating: r.rating, favorite: r.favorite, portfolio: r.portfolio,
    captureAt: iso(r.capture_at), captureOffset: offsetText(r.capture_offset_min), year: r.year, folderYear: r.folder_year, location: r.location, importedAt: iso(r.ingested_at)!,
    ig: { state: igStateOf(e), count: e?.posted_count ?? 0, lastPostedAt: iso(e?.last_posted_at ?? null), possibleDuplicate: e?.possible ?? false },
    ai: e?.ai ?? 'none', synthetic: r.exif_synth !== null, dominant: r.dominant, duplicateOpen: e?.dup ?? false,
  };
}

const igStateOf = (e: EnrichRow | undefined): IgState => (!e ? 'NEVER_POSTED' : e.has_scheduled ? 'SCHEDULED' : e.has_draft ? 'DRAFT' : e.posted_count > 0 ? 'POSTED' : 'NEVER_POSTED');

export class LibraryService {
  constructor(private readonly sql: Sql) {}

  async list(userId: string, p: ListParams): Promise<PhotoPage | { invalidCursor: true }> {
    const cursor = p.cursor ? decodeCursor(p.cursor) : null;
    if (p.cursor && !cursor) return { invalidCursor: true };
    return withUser(this.sql, userId, async (tx) => {
      const where = whereFor(tx, p);
      const keyExpr = SORT_DEFS[p.sort].expr(tx);
      const after = cursor ? tx`AND ${afterCursor(tx, p.sort, p.dir, cursor)}` : tx``;
      const [rows, totalRow] = await Promise.all([
        tx<ListRow[]>`
          SELECT p.id, v.id AS version_id, v.width, v.height, p.title, v.source_relpath AS relpath, p.rating, p.favorite, p.portfolio_candidate AS portfolio,
                 p.capture_at, p.capture_offset_min, p.capture_year AS year, p.year AS folder_year, p.trip_location AS location, v.ingested_at, v.exif -> 'synthetic' ->> 'fixture' AS exif_synth, v.dominant_colors ->> 0 AS dominant,
                 (${keyExpr})::text AS sort_key
            FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
           WHERE ${where} ${after}
           ORDER BY ${orderBy(tx, p.sort, p.dir)}
           LIMIT ${p.limit + 1}`,
        cursor ? Promise.resolve(null) : tx<{ n: string }[]>`SELECT count(*) AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where}`,
      ]);
      const more = rows.length > p.limit;
      const page = more ? rows.slice(0, p.limit) : rows;
      const extra = await enrich(tx, page.map((r) => r.id));
      const items: PhotoCard[] = page.map((r) => mapCard(r, extra.get(r.id)));
      const last = page[page.length - 1];
      const numeric = SORT_DEFS[p.sort].cast === 'int';
      const nextCursor = more && last ? encodeCursor({ v: last.sort_key === null ? null : numeric ? Number(last.sort_key) : last.sort_key, id: last.id }) : null;
      return { items, nextCursor, ...(totalRow ? { total: Number(totalRow[0]!.n) } : {}) };
    });
  }

  /** Cards for specific photographs (any visibility), in the order requested. RLS decides what the caller may see. */
  async cards(userId: string, ids: string[]): Promise<PhotoCard[]> {
    if (!ids.length) return [];
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx<ListRow[]>`
        SELECT p.id, v.id AS version_id, v.width, v.height, p.title, v.source_relpath AS relpath, p.rating, p.favorite, p.portfolio_candidate AS portfolio,
               p.capture_at, p.capture_offset_min, p.capture_year AS year, p.year AS folder_year, p.trip_location AS location, v.ingested_at, v.exif -> 'synthetic' ->> 'fixture' AS exif_synth, v.dominant_colors ->> 0 AS dominant, NULL::text AS sort_key
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = ANY(${ids}::uuid[]) AND p.deleted_at IS NULL`;
      const extra = await enrich(tx, rows.map((r) => r.id));
      const by = new Map(rows.map((r) => [r.id, mapCard(r, extra.get(r.id))]));
      return ids.map((i) => by.get(i)).filter((c): c is PhotoCard => !!c);
    });
  }

  /** Counts of what exists, for the filter panel. Computed in PostgreSQL over the Library's visible photographs. */
  private facetInflight = new Map<string, Promise<Awaited<ReturnType<LibraryService['computeFacets']>>>>();
  private facetCache = new Map<string, { stamp: string; value: Awaited<ReturnType<LibraryService['computeFacets']>> }>();
  /**
   * The aggregation scans the whole library, so its result is kept per person until something changes. "Something changed" is read from a cheap stamp
   * (newest update + row count over photographs, which also moves on insert, edit, hide and delete) — so the answer is never stale, only usually free.
   */
  async facets(userId: string) {
    const stamp = await withUser(this.sql, userId, async (tx) => { const [r] = await tx<{ s: string }[]>`SELECT coalesce(max(p.updated_at)::text, '') || '/' || count(*) AS s FROM photos p`; return r!.s; });
    let value = this.facetCache.get(userId)?.stamp === stamp ? this.facetCache.get(userId)!.value : null;
    if (!value) {                                                       // concurrent requests for the same state share ONE computation (a cold start would otherwise run it once per request)
      const key = `${userId}|${stamp}`; let p = this.facetInflight.get(key);
      if (!p) { p = this.computeFacets(userId).finally(() => this.facetInflight.delete(key)); this.facetInflight.set(key, p); }
      value = await p; this.facetCache.set(userId, { stamp, value }); if (this.facetCache.size > 50) this.facetCache.delete(this.facetCache.keys().next().value!);
    }
    // these two live in other tables and change without touching photographs, so they are always read fresh (both are small)
    const [live] = await withUser(this.sql, userId, (tx) => tx<{ possible: number; open_pairs: number }[]>`SELECT (SELECT count(DISTINCT m.photo_id)::int FROM photo_social_matches m WHERE m.state = 'POSSIBLE_MATCH') AS possible, (SELECT count(*)::int FROM duplicate_pairs d WHERE d.state = 'OPEN') AS open_pairs`);
    return { ...value, possibleDuplicates: live!.possible, openDuplicatePairs: live!.open_pairs };
  }
  private async computeFacets(userId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const base = whereFor(tx, FiltersSchema.parse({}));
      // ONE pass over the visible photographs feeds every group (ten separate scans cost 0.8 s at 100,000 photographs)
      const [rows, totals, camRows] = await Promise.all([
        tx<{ dim: string; value: string; n: number }[]>`
          WITH b AS MATERIALIZED (
            SELECT p.capture_year, p.capture_month, p.year AS folder_year, p.trip_location, p.place_country, p.place_city, v.lens,
                   CASE WHEN strpos(v.source_relpath, '/') > 0 THEN left(v.source_relpath, length(v.source_relpath) - strpos(reverse(v.source_relpath), '/')) END AS folder
              FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${base})
          SELECT d.dim, d.value, count(*)::int AS n FROM b CROSS JOIN LATERAL (VALUES
            ('years', b.capture_year::text), ('months', b.capture_month::text), ('folderYears', b.folder_year::text), ('locations', b.trip_location), ('countries', b.place_country),
            ('cities', b.place_city), ('lenses', b.lens), ('folders', b.folder)) AS d(dim, value)
          WHERE d.value IS NOT NULL GROUP BY d.dim, d.value`,
        tx<{ n: number; possible: number; open_pairs: number }[]>`SELECT count(*)::int AS n,
            (SELECT count(DISTINCT m.photo_id)::int FROM photo_social_matches m WHERE m.state = 'POSSIBLE_MATCH') AS possible,
            (SELECT count(*)::int FROM duplicate_pairs d WHERE d.state = 'OPEN') AS open_pairs
            FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${base}`,
        // the (expensive) label rule runs on the few distinct make/model pairs, not on every photograph
        tx<{ value: string; n: number }[]>`SELECT ${cameraLabel(tx)} AS value, sum(c.n)::int AS n
            FROM (SELECT v.camera_make, v.camera_model, count(*)::int AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${base} AND v.camera_model IS NOT NULL GROUP BY 1, 2) c
            CROSS JOIN LATERAL (SELECT c.camera_make, c.camera_model) v GROUP BY 1`,
      ]);
      rows.push(...camRows.map((r) => ({ dim: 'cameras', value: r.value, n: r.n })));
      const group = (dim: string) => rows.filter((r) => r.dim === dim);
      const byCount = (dim: string, limit: number) => group(dim).sort((x, y) => y.n - x.n || (x.value < y.value ? -1 : x.value > y.value ? 1 : 0)).slice(0, limit).map((r) => ({ value: r.value, n: r.n }));
      const numeric = (dim: string, dir: 1 | -1) => group(dim).map((r) => ({ value: Number(r.value), n: r.n })).sort((x, y) => dir * (x.value - y.value));
      const alpha = (dim: string, limit: number) => group(dim).sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0)).slice(0, limit).map((r) => ({ value: r.value, n: r.n }));
      const years = numeric('years', -1), months = numeric('months', 1), folderYears = numeric('folderYears', -1);
      const locations = byCount('locations', 200), cameras = byCount('cameras', 100), lenses = byCount('lenses', 100), countries = byCount('countries', 100), cities = byCount('cities', 200), folders = alpha('folders', 2000);
      return { total: totals[0]!.n, possibleDuplicates: totals[0]!.possible, openDuplicatePairs: totals[0]!.open_pairs, years, months, folderYears, folders, locations, countries, cities, cameras, lenses };
    });
  }

  async detail(userId: string, id: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [r] = await tx<Array<Record<string, unknown>>>`
        SELECT p.id, p.title, p.title_source, p.capture_at, p.capture_at_source, p.capture_offset_min, p.capture_offset_source, to_char(p.capture_local, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS capture_local, p.capture_year, p.year, p.trip_location, p.trip_location_source, p.subpath, p.rating, p.favorite,
               p.place_city, p.place_state, p.place_country, p.place_country_code, p.place_sublocation, p.place_source, p.color_label,
               p.portfolio_candidate AS portfolio, p.notes, p.description, p.description_source, p.hidden, p.created_at, p.updated_at,
               v.id AS version_id, v.version_no, v.source_relpath, v.source_present, v.width, v.height, v.bytes, v.ingested_at, v.exported_at, v.source_mtime,
               v.camera_make, v.camera_model, v.lens, v.focal_length_mm, v.aperture, v.shutter_s, v.iso, v.copyright, v.photographer, v.keywords, v.keywords_hier,
               v.gps_lat, v.gps_lon, v.gps_altitude_m, v.gps_source, v.gps_label, v.gps_original_lat, v.gps_original_lon, v.gps_original_source, v.exif, v.dominant_colors, v.deriv_status, ${cameraLabel(tx)} AS camera,
               (SELECT count(*)::int FROM photo_versions x WHERE x.photo_id = p.id) AS version_count
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
         WHERE p.id = ${id}::uuid AND p.deleted_at IS NULL`;
      if (!r) return null;
      const [species, analysis, collections, history, extra] = await Promise.all([
        tx`SELECT s.common_name AS name, s.scientific_name AS scientific, ps.confidence, ps.status, ps.source, ps.behavior, ps.habitat, ps.subject_count AS count
             FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = ${id}::uuid AND ps.status <> 'REJECTED' ORDER BY ps.confidence DESC NULLS LAST`,
        tx`SELECT a.provider, a.model, a.mode, a.created_at, a.primary_subject, a.description, a.suggested_title, a.environment, a.scenes, a.tags, a.scores, a.overall_score
             FROM ai_analyses a WHERE a.photo_version_id = ${r.version_id as string}::uuid ORDER BY a.created_at DESC LIMIT 1`,
        tx`SELECT c.id, c.name, c.kind FROM collection_photos cp JOIN collections c ON c.id = cp.collection_id WHERE cp.photo_id = ${id}::uuid ORDER BY c.name`,
        tx`SELECT sp.id, sp.posted_at, sp.permalink, sp.caption, m.state, m.score
             FROM photo_social_matches m JOIN social_post_media spm ON spm.id = m.social_post_media_id JOIN social_posts sp ON sp.id = spm.social_post_id
            WHERE m.photo_id = ${id}::uuid AND m.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED','POSSIBLE_MATCH') ORDER BY sp.posted_at DESC LIMIT 20`,
        enrich(tx, [id]),
      ]);
      const e = extra.get(id);
      const width = r.width as number, height = r.height as number;
      const a = analysis[0];
      return {
        id, versionId: r.version_id as string, versionNo: r.version_no as number, versionCount: r.version_count as number,
        title: (r.title as string | null) ?? filenameOf(r.source_relpath as string), titleSource: r.title_source as string | null,
        filename: filenameOf(r.source_relpath as string), relativePath: r.source_relpath as string, sourcePresent: r.source_present as boolean,
        width, height, orientation: orientationOf(width, height), bytes: r.bytes === null ? null : Number(r.bytes),
        captureAt: iso(r.capture_at as Date | null), captureAtSource: r.capture_at_source as string | null,
        /** the wall clock the camera wrote ("2025-12-20T08:13:53.773"), the UTC offset when known ("-07:00") and where it came from */
        captureLocal: r.capture_local as string | null, captureOffset: offsetText(r.capture_offset_min as number | null), captureOffsetSource: r.capture_offset_source as string | null,
        year: r.capture_year as number | null, folderYear: r.year as number | null,
        place: { city: r.place_city as string | null, state: r.place_state as string | null, country: r.place_country as string | null, countryCode: r.place_country_code as string | null, sublocation: r.place_sublocation as string | null, source: r.place_source as string | null },
        colorLabel: r.color_label as string | null,
        location: r.trip_location as string | null, locationSource: r.trip_location_source as string | null,
        importedAt: iso(r.ingested_at as Date), exportedAt: iso(r.exported_at as Date | null), modifiedAt: iso(r.updated_at as Date),
        rating: r.rating as number, favorite: r.favorite as boolean, portfolio: r.portfolio as boolean, notes: r.notes as string | null,
        description: r.description as string | null, descriptionSource: r.description_source as string | null, hidden: r.hidden as boolean,
        synthetic: (r.exif as { synthetic?: unknown } | null)?.synthetic !== undefined,
        exif: {
          camera: r.camera as string | null, lens: r.lens as string | null, focalLengthMm: r.focal_length_mm as number | null, aperture: r.aperture as number | null,
          shutterSeconds: r.shutter_s as number | null, iso: r.iso as number | null, copyright: r.copyright as string | null, photographer: r.photographer as string | null,
          keywords: r.keywords as string[], keywordPaths: r.keywords_hier as string[],
          gps: r.gps_lat === null ? null : { lat: r.gps_lat as number, lon: r.gps_lon as number, altitudeM: r.gps_altitude_m as number | null, source: r.gps_source as string, approximate: r.gps_source === 'GEOCODED', label: (r.gps_label as string | null) ?? null },
          cameraGps: r.gps_original_lat !== null ? { lat: r.gps_original_lat as number, lon: r.gps_original_lon as number, source: r.gps_original_source as string, inUse: r.gps_source === r.gps_original_source && r.gps_lat === r.gps_original_lat && r.gps_lon === r.gps_original_lon } : (r.gps_source === 'EXIF' || r.gps_source === 'IPTC') && r.gps_lat !== null ? { lat: r.gps_lat as number, lon: r.gps_lon as number, source: r.gps_source as string, inUse: true } : null,
        },
        ig: { state: igStateOf(e), count: e?.posted_count ?? 0, lastPostedAt: iso(e?.last_posted_at ?? null), possibleDuplicate: e?.possible ?? false },
        ai: { status: e?.ai ?? 'none', species, analysis: a ? { ...a, created_at: iso(a.created_at as Date) } : null },
        collections, history: history.map((h) => ({ ...h, posted_at: iso(h.posted_at as Date) })),
      };
    });
  }

  async update(userId: string, id: string, set: PhotoSet): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx`UPDATE photos SET rating = coalesce(${set.rating ?? null}::smallint, rating), favorite = coalesce(${set.favorite ?? null}::boolean, favorite),
                              portfolio_candidate = coalesce(${set.portfolio ?? null}::boolean, portfolio_candidate), hidden = coalesce(${set.hidden ?? null}::boolean, hidden)
                            WHERE id = ${id}::uuid AND deleted_at IS NULL RETURNING id`;
      return rows.length === 1;
    });
  }

  /** Bulk edit either an explicit list of ids, or "everything matching this filter except these ids" (select-all-in-results). */
  async bulk(userId: string, target: BulkTarget, set: PhotoSet): Promise<{ updated: number }> {
    return withUser(this.sql, userId, async (tx) => {
      const apply = tx`SET rating = coalesce(${set.rating ?? null}::smallint, rating), favorite = coalesce(${set.favorite ?? null}::boolean, favorite),
                           portfolio_candidate = coalesce(${set.portfolio ?? null}::boolean, portfolio_candidate), hidden = coalesce(${set.hidden ?? null}::boolean, hidden)`;
      if ('ids' in target) {
        const rows = await tx`UPDATE photos ${apply} WHERE id = ANY(${target.ids}::uuid[]) AND deleted_at IS NULL RETURNING id`;
        return { updated: rows.length };
      }
      const where = whereFor(tx, target.query);
      const rows = await tx`UPDATE photos ${apply}
        WHERE id IN (SELECT p.id FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where} AND p.id <> ALL(${target.exclude}::uuid[])) RETURNING id`;
      return { updated: rows.length };
    });
  }

  /** The row the image endpoint needs: only the owner can resolve it (RLS). */
  async imageSource(userId: string, id: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [r] = await tx<{ version_id: string; deriv_status: string; fixture: string | null }[]>`
        SELECT v.id AS version_id, v.deriv_status, v.exif -> 'synthetic' ->> 'fixture' AS fixture
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = ${id}::uuid AND p.deleted_at IS NULL`;
      return r ? { versionId: r.version_id, derivStatus: r.deriv_status, fixture: r.fixture } : null;
    });
  }

  async getPreferences(userId: string): Promise<LibraryPrefs> {
    return withUser(this.sql, userId, async (tx) => {
      await tx`INSERT INTO user_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
      const [s] = await tx<{ lib: unknown }[]>`SELECT settings -> 'library' AS lib FROM user_settings WHERE user_id = ${userId}`;
      const parsed = PrefsSchema.safeParse(s?.lib ?? {});
      return parsed.success ? parsed.data : PrefsSchema.parse({});
    });
  }

  async setPreferences(userId: string, prefs: LibraryPrefs): Promise<LibraryPrefs> {
    await withUser(this.sql, userId, async (tx) => {
      await tx`INSERT INTO user_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
      await tx`UPDATE user_settings SET settings = jsonb_set(settings, '{library}', ${tx.json(prefs)}, true) WHERE user_id = ${userId}`;
    });
    return this.getPreferences(userId);
  }
}

export interface PhotoSet { rating?: number; favorite?: boolean; portfolio?: boolean; hidden?: boolean }
export type BulkTarget = { ids: string[] } | { query: Filters; exclude: string[] };

/** Per-user Library preferences (view, sort, filters). Stored in user_settings.settings -> 'library'. */
export const PrefsSchema = z.object({
  view: FiltersSchema.shape.view,
  sort: z.enum(['captured', 'imported', 'filename', 'rating', 'modified']).default('captured'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  filters: FiltersSchema.omit({ view: true, q: true }).default({}),
}).strict();
export type LibraryPrefs = z.infer<typeof PrefsSchema>;
