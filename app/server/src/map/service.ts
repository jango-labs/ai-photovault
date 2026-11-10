import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { FilterShape, FiltersSchema, whereFor } from '../library/query.js';

/**
 * The Map shows only coordinates that are stored on a photograph — read from the file (EXIF/IPTC), placed by a person, looked up from a place name the person typed
 * (GEOCODED: the centre of the place, shown as approximate), derived from a folder or suggested by AI — and says which. It never guesses a position by itself:
 * a place name is resolved only when the person saves a location or presses "Find on map" (see geo/geocoder.ts), never in the background.
 */
export const MAX_ZOOM = 18;
export const MIN_BOX = 0.00001;
const { bbox: _bbox, gps: _gps, ...FILTERS_WITHOUT_AREA } = FilterShape;
export const ClusterSchema = z.object({
  ...FILTERS_WITHOUT_AREA, gps: FilterShape.gps,
  bbox: FilterShape.bbox.refine((b) => b !== undefined, 'a map view needs a bounding box'),
  zoom: z.coerce.number().min(0).max(MAX_ZOOM).default(2),
  /** target size of a cluster cell in CSS pixels at 256-px tiles; larger = fewer, bigger clusters */
  cell: z.coerce.number().int().min(24).max(160).default(64),
}).strict();
export type ClusterParams = z.infer<typeof ClusterSchema>;

export interface Cluster {
  lat: number; lon: number; count: number; sources: Record<string, number>;
  /** a representative photograph (highest rated, then newest) for a thumbnail */
  photoId: string;
  /** tight box around the members, for "zoom to fit" */
  bbox: [number, number, number, number];
}
export interface ClusterResult { clusters: Cluster[]; shown: number; zoom: number }

const SUMMARY_FILTERS = FiltersSchema.omit({ bbox: true, gps: true });
export type SummaryParams = z.infer<typeof SUMMARY_FILTERS>;
export const SummarySchema = SUMMARY_FILTERS;

export class MapService {
  constructor(private readonly sql: Sql) {}

  /** Grid clustering in PostgreSQL: lon/lat are snapped to cells whose size follows the zoom, so the cost depends on the box, not on the library. */
  async clusters(userId: string, p: ClusterParams): Promise<ClusterResult> {
    const { bbox, zoom, cell, ...rest } = p; const [w, s, e, n] = bbox!;
    const filters = FiltersSchema.parse({ ...rest, bbox: undefined });
    const degPerPx = 360 / (256 * 2 ** zoom); const cellLon = Math.max(degPerPx * cell, 1e-7); const cellLat = cellLon;      // equal degrees: simple and stable; Mercator distortion is cosmetic at cluster scale
    const rows = await withUser(this.sql, userId, async (tx) => {
      const where = whereFor(tx, filters, [tx`v.gps_lat IS NOT NULL`, tx`v.gps_lat BETWEEN ${s} AND ${n}`, tx`v.gps_lon BETWEEN ${w} AND ${e}`]);
      return tx<Array<{ lat: number; lon: number; count: number; sources: Record<string, number>; photo_id: string; w: number; s: number; e: number; n: number }>>`
        WITH pts AS (
          SELECT p.id, v.gps_lat AS lat, v.gps_lon AS lon, v.gps_source AS src, p.rating, p.capture_at,
                 floor((v.gps_lon + 180) / ${cellLon})::bigint AS cx, floor((v.gps_lat + 90) / ${cellLat})::bigint AS cy
            FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where}),
        per AS (
          SELECT cx, cy, src, count(*)::int AS c, sum(lat) AS slat, sum(lon) AS slon, min(lon) AS w, min(lat) AS s, max(lon) AS e, max(lat) AS n,
                 (array_agg(id ORDER BY rating DESC, capture_at DESC NULLS LAST, id))[1] AS best_id, max(rating) AS best_rating
            FROM pts GROUP BY cx, cy, src)
        SELECT sum(slat) / sum(c) AS lat, sum(slon) / sum(c) AS lon, sum(c)::int AS count, jsonb_object_agg(src, c) AS sources,
               (array_agg(best_id ORDER BY best_rating DESC, best_id))[1] AS photo_id, min(w) AS w, min(s) AS s, max(e) AS e, max(n) AS n
          FROM per GROUP BY cx, cy ORDER BY sum(c) DESC, cx, cy LIMIT 1500`;
    });
    const clusters: Cluster[] = rows.map((r) => ({ lat: r.lat, lon: r.lon, count: r.count, sources: r.sources, photoId: r.photo_id, bbox: [r.w, r.s, r.e, r.n] }));
    return { clusters, shown: clusters.reduce((a, c) => a + c.count, 0), zoom };
  }

  /** How much of the library can be placed at all, and by what evidence. */
  async summary(userId: string, f: SummaryParams) {
    return withUser(this.sql, userId, async (tx) => {
      const where = whereFor(tx, FiltersSchema.parse(f));
      const [bySource, named, typed] = await Promise.all([
        tx<{ src: string | null; n: number }[]>`SELECT v.gps_source AS src, count(*)::int AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where} GROUP BY 1`,
        tx<{ n: number }[]>`SELECT count(*)::int AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where} AND v.gps_lat IS NULL AND p.trip_location IS NOT NULL`,
        tx<{ n: number }[]>`SELECT count(*)::int AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where} AND v.gps_lat IS NULL AND p.trip_location IS NOT NULL AND p.trip_location_source = 'USER_DEFINED'`,
      ]);
      const sources: Record<string, number> = {}; let without = 0;
      for (const r of bySource) { if (r.src === null) without += r.n; else sources[r.src] = r.n; }
      const placed = Object.values(sources).reduce((a, b) => a + b, 0);
      return { total: placed + without, placed, withoutCoordinates: without, withPlaceNameOnly: named[0]!.n, typedPlaceNameOnly: typed[0]!.n, sources };
    });
  }
}
