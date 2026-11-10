import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import type { LookupResult } from '../geo/geocoder.js';
import { FiltersSchema, whereFor, type Filters } from './query.js';

/**
 * Photograph metadata editing. The photographer always wins: every edit is stored with provenance USER_DEFINED and
 * recorded (old value, new value, old/new source) in the append-only `photo_edits` table, so nothing is ever lost
 * and any edit can be undone. Editing never touches a file: it changes database rows only.
 */
export const MetaPatchSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  captureAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** a position typed or placed by hand; `approximate: true` marks the centre of a looked-up place (never an exact photograph position) */
  gps: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), approximate: z.boolean().optional(), label: z.string().trim().max(200).optional() }).strict().nullable().optional(),
  /** put back the coordinates the camera recorded */
  gpsRestore: z.literal(true).optional(),
  /** look the location text up on the map now, even if the text did not change */
  locate: z.boolean().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, 'nothing to change').refine((p) => !(p.gpsRestore && p.gps !== undefined), 'choose either a position or the camera position');
export type MetaPatch = z.infer<typeof MetaPatchSchema>;

export type EditField = 'title' | 'description' | 'notes' | 'capture_at' | 'trip_location' | 'gps' | 'current_version' | 'hidden';
export interface EditRow {
  id: string; photoId: string; batchId: string; field: EditField; oldValue: unknown; newValue: unknown; oldSource: string | null; newSource: string | null;
  kind: 'EDIT' | 'UNDO' | 'BULK'; revertsId: string | null; editedAt: string; undone: boolean;
}

interface Current {
  title: string | null; title_source: string | null; description: string | null; description_source: string | null; notes: string | null;
  capture_at: Date | null; capture_at_source: string | null; capture_offset_min: number | null; capture_offset_source: string | null; year: number | null; trip_location: string | null; trip_location_source: string | null;
  current_version_id: string; gps_lat: number | null; gps_lon: number | null; gps_source: string | null; gps_label: string | null;
  gps_original_lat: number | null; gps_original_lon: number | null; gps_original_source: string | null;
}
interface GpsValue { lat: number; lon: number; label?: string }
/** the stored form of a position in the edit history: {lat, lon} plus the place found, for a looked-up position */
const gpsValue = (c: Current): GpsValue | null => (c.gps_lat === null || c.gps_lon === null ? null : { lat: c.gps_lat, lon: c.gps_lon, ...(c.gps_source === 'GEOCODED' && c.gps_label ? { label: c.gps_label } : {}) });
/** sources that only *suggest* a position: a lookup may replace them. A camera, IPTC or hand-placed position is never replaced by a lookup. */
const SOFT_GPS = new Set<string | null>([null, 'GEOCODED', 'FOLDER_DERIVED', 'AI_INFERRED']);
export interface GeocodeInfo { status: 'placed' | 'cleared' | 'kept_exact' | 'not_found' | 'unavailable' | 'disabled'; query: string; label?: string; lat?: number; lon?: number; message?: string }
export interface GeoLookup { query: string; result: LookupResult }
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const none = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v);

export type EditOutcome = { status: 'ok'; changed: string[]; batchId: string; geocode?: GeocodeInfo } | { status: 'not_found' };
export type UndoOutcome = { status: 'ok' } | { status: 'not_found' | 'already_undone' | 'is_undo' | 'conflict' };
export type RestoreOutcome = { status: 'ok'; changed: boolean } | { status: 'not_found' };

export class EditService {
  constructor(private readonly sql: Sql) {}

  private async load(tx: Sql, photoId: string): Promise<Current | undefined> {
    const [c] = await tx<Current[]>`
      SELECT p.title, p.title_source, p.description, p.description_source, p.notes, p.capture_at, p.capture_at_source, p.capture_offset_min, p.capture_offset_source, p.year, p.trip_location, p.trip_location_source,
             p.current_version_id, v.gps_lat, v.gps_lon, v.gps_source, v.gps_label, v.gps_original_lat, v.gps_original_lon, v.gps_original_source
        FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = ${photoId}::uuid AND p.deleted_at IS NULL FOR UPDATE OF p`;
    return c;
  }

  /** Applies `field → value (+source)` to the photograph. Returns the previous value/source for the history row. */
  private async apply(tx: Sql, photoId: string, cur: Current, field: EditField, value: unknown, source: string | null, offsetMin: number | null = null): Promise<void> {
    switch (field) {
      case 'title': await tx`UPDATE photos SET title = ${value as string | null}, title_source = ${value === null ? null : source}::meta_source WHERE id = ${photoId}::uuid`; break;
      case 'description': await tx`UPDATE photos SET description = ${value as string | null}, description_source = ${value === null ? null : source}::meta_source WHERE id = ${photoId}::uuid`; break;
      case 'notes': await tx`UPDATE photos SET notes = ${value as string | null} WHERE id = ${photoId}::uuid`; break;
      case 'trip_location': await tx`UPDATE photos SET trip_location = ${value as string | null}, trip_location_source = ${value === null ? null : source}::meta_source WHERE id = ${photoId}::uuid`; break;
      case 'capture_at': {
        const d = value === null ? null : new Date(value as string);
        // the folder year is never touched: the capture year/month follow the capture time automatically (database). The UTC offset travels with the time.
        await tx`UPDATE photos SET capture_at = ${d}, capture_at_source = ${d === null ? null : source}::meta_source,
                   capture_offset_min = ${d === null ? null : offsetMin}, capture_offset_source = ${d === null || offsetMin === null ? null : 'USER_DEFINED'} WHERE id = ${photoId}::uuid`;
        break;
      }
      case 'gps': {
        const g = value as GpsValue | null;
        // the coordinates the camera (or IPTC) recorded are kept aside the first time anything else replaces them, and are never overwritten
        if (cur.gps_lat !== null && cur.gps_lon !== null && (cur.gps_source === 'EXIF' || cur.gps_source === 'IPTC') && cur.gps_original_lat === null && (g === null || g.lat !== cur.gps_lat || g.lon !== cur.gps_lon || source !== cur.gps_source)) {
          await tx`UPDATE photo_versions SET gps_original_lat = ${cur.gps_lat}, gps_original_lon = ${cur.gps_lon}, gps_original_source = ${cur.gps_source}::meta_source WHERE id = ${cur.current_version_id}::uuid`;
          cur.gps_original_lat = cur.gps_lat; cur.gps_original_lon = cur.gps_lon; cur.gps_original_source = cur.gps_source;
        }
        const label = g && source === 'GEOCODED' ? (g.label ?? null) : null;
        await tx`UPDATE photo_versions SET gps_lat = ${g?.lat ?? null}, gps_lon = ${g?.lon ?? null}, gps_source = ${g ? source : null}::meta_source, gps_label = ${label} WHERE id = ${cur.current_version_id}::uuid`;
        cur.gps_lat = g?.lat ?? null; cur.gps_lon = g?.lon ?? null; cur.gps_source = g ? source : null; cur.gps_label = label;
        break;
      }
      default: throw new Error(`cannot apply ${field}`);
    }
  }

  /** The place text that should be looked up for this edit (so the network call can happen BEFORE the database transaction), or null when none is needed. */
  async geocodeQuery(userId: string, photoId: string, patch: MetaPatch): Promise<string | null> {
    if (patch.gps !== undefined || patch.gpsRestore) return null;                           // an explicit position wins: nothing to look up
    return withUser(this.sql, userId, async (tx) => {
      const [c] = await tx<{ trip_location: string | null; trip_location_source: string | null }[]>`SELECT trip_location, trip_location_source FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL`;
      if (!c) return null;
      // a position is also looked up when the text did not change but the photograph has none yet: the text may have been saved before lookups existed (or while the service was down)
      const [g] = await tx<{ has: boolean }[]>`SELECT (v.gps_lat IS NOT NULL) AS has FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = ${photoId}::uuid`;
      const unplaced = g?.has === false;
      if (patch.location !== undefined) { const next = none(patch.location); if (next === null) return c.trip_location !== null ? '' : null; return next !== c.trip_location || patch.locate === true || unplaced ? next : null; }   // '' = the text was cleared
      return patch.locate === true ? none(c.trip_location) : null;
    });
  }

  async edit(userId: string, photoId: string, patch: MetaPatch, geo?: GeoLookup): Promise<EditOutcome> {
    return withUser(this.sql, userId, async (tx) => {
      const cur = await this.load(tx, photoId);
      if (!cur) return { status: 'not_found' as const };
      const batchId = randomUUID();
      const changed: string[] = [];
      const record = async (field: EditField, oldV: unknown, newV: unknown, oldS: string | null, newS: string | null, oldOff: number | null = null, newOff: number | null = null) => {
        await tx`INSERT INTO photo_edits (user_id, photo_id, batch_id, field, old_value, new_value, old_source, new_source, kind, old_offset_min, new_offset_min)
                 VALUES (${userId}, ${photoId}::uuid, ${batchId}::uuid, ${field}, ${tx.json((oldV ?? null) as never)}, ${tx.json((newV ?? null) as never)}, ${oldS}, ${newS}, 'EDIT', ${oldOff}, ${newOff})`;
        changed.push(field);
      };
      const text = async (field: 'title' | 'description' | 'notes' | 'trip_location', incoming: string | null | undefined, old: string | null, oldSource: string | null) => {
        if (incoming === undefined) return;
        const next = none(incoming);
        if (next === old && (next === null || oldSource === 'USER_DEFINED' || field === 'notes')) return;
        await this.apply(tx, photoId, cur, field, next, 'USER_DEFINED');
        await record(field, old, next, field === 'notes' ? null : oldSource, next === null || field === 'notes' ? null : 'USER_DEFINED');
      };
      await text('title', patch.title, cur.title, cur.title_source);
      await text('description', patch.description, cur.description, cur.description_source);
      await text('notes', patch.notes, cur.notes, null);
      await text('trip_location', patch.location, cur.trip_location, cur.trip_location_source);
      if (patch.captureAt !== undefined) {
        const next = patch.captureAt === null ? null : new Date(patch.captureAt).toISOString();
        // an offset typed with the time (…-07:00, or Z for UTC) is kept; a time without one has none
        const typed = patch.captureAt === null ? null : /([+-])(\d{2}):(\d{2})$/.exec(patch.captureAt);
        const nextOffset = patch.captureAt === null ? null : typed ? (typed[1] === '-' ? -1 : 1) * (Number(typed[2]) * 60 + Number(typed[3])) : /Z$/i.test(patch.captureAt) ? 0 : null;
        if (next !== iso(cur.capture_at) || nextOffset !== cur.capture_offset_min || (next !== null && cur.capture_at_source !== 'USER_DEFINED')) {
          await this.apply(tx, photoId, cur, 'capture_at', next, 'USER_DEFINED', nextOffset);
          await record('capture_at', iso(cur.capture_at), next, cur.capture_at_source, next === null ? null : 'USER_DEFINED', cur.capture_offset_min, nextOffset);
        }
      }
      // ---- position: a hand-placed pin, the camera position put back, or a place-name lookup. The camera's own coordinates are never lost (see apply).
      const changeGps = async (next: GpsValue | null, source: string | null) => {
        const old = gpsValue(cur); const oldSource = cur.gps_source;
        await this.apply(tx, photoId, cur, 'gps', next, source);
        await record('gps', old, next, oldSource, next === null ? null : source);
      };
      let geocode: GeocodeInfo | undefined;
      if (patch.gpsRestore) {
        if (cur.gps_original_lat !== null && cur.gps_original_lon !== null && cur.gps_original_source !== null && (cur.gps_lat !== cur.gps_original_lat || cur.gps_lon !== cur.gps_original_lon || cur.gps_source !== cur.gps_original_source)) await changeGps({ lat: cur.gps_original_lat, lon: cur.gps_original_lon }, cur.gps_original_source);
      } else if (patch.gps !== undefined) {
        if (patch.gps === null) {
          // removing a position you or a lookup put there brings the camera's position back; with none to bring back (or when it IS the camera position) it clears the position
          if (cur.gps_lat !== null) {
            if (!['EXIF', 'IPTC'].includes(cur.gps_source ?? '') && cur.gps_original_lat !== null) await changeGps({ lat: cur.gps_original_lat, lon: cur.gps_original_lon! }, cur.gps_original_source);
            else await changeGps(null, null);
          }
        } else {
          const source = patch.gps.approximate ? 'GEOCODED' : 'USER_DEFINED'; const next: GpsValue = { lat: patch.gps.lat, lon: patch.gps.lon, ...(source === 'GEOCODED' && patch.gps.label ? { label: patch.gps.label } : {}) };
          const old = gpsValue(cur); if (JSON.stringify(old) !== JSON.stringify(next) || cur.gps_source !== source) await changeGps(next, source);
        }
      } else if (geo) {
        // the location text changed (or "find on map" was pressed): resolve it to the centre of the place — but only where no exact position exists
        const text = none(geo.query);
        if (text === null) { if (cur.gps_source === 'GEOCODED') { await changeGps(null, null); geocode = { status: 'cleared', query: '' }; } }
        else if (!SOFT_GPS.has(cur.gps_source)) geocode = { status: 'kept_exact', query: text, message: 'This photograph already has an exact position, so it was kept.' };
        else if (geo.result.status === 'ok') {
          const c = geo.result.candidates[0]!; const next: GpsValue = { lat: c.lat, lon: c.lon, label: c.label };
          if (JSON.stringify(gpsValue(cur)) !== JSON.stringify(next) || cur.gps_source !== 'GEOCODED') await changeGps(next, 'GEOCODED');
          geocode = { status: 'placed', query: text, label: c.label, lat: c.lat, lon: c.lon };
        } else {
          if (cur.gps_source === 'GEOCODED') await changeGps(null, null);                   // the old lookup belonged to the old text
          geocode = geo.result.status === 'not_found' ? { status: 'not_found', query: text, message: `“${text}” was not found on the map; the text was kept.` }
            : geo.result.status === 'disabled' ? { status: 'disabled', query: text, message: 'Looking places up is switched off; the text was kept.' }
            : { status: 'unavailable', query: text, message: `${geo.result.reason}. The text was kept; press “Find on map” to try again.` };
        }
      }
      return { status: 'ok' as const, changed, batchId, ...(geocode ? { geocode } : {}) };
    });
  }

  async history(userId: string, photoId: string, limit = 100): Promise<EditRow[] | null> {
    return withUser(this.sql, userId, async (tx) => {
      const [p] = await tx`SELECT 1 FROM photos WHERE id = ${photoId}::uuid`;
      if (!p) return null;
      const rows = await tx<Array<{ id: string; photo_id: string; batch_id: string; field: EditField; old_value: unknown; new_value: unknown; old_source: string | null; new_source: string | null; kind: EditRow['kind']; reverts_id: string | null; edited_at: Date; undone: boolean }>>`
        SELECT e.id, e.photo_id, e.batch_id, e.field, e.old_value, e.new_value, e.old_source, e.new_source, e.kind, e.reverts_id, e.edited_at,
               EXISTS (SELECT 1 FROM photo_edits u WHERE u.reverts_id = e.id) AS undone
          FROM photo_edits e WHERE e.photo_id = ${photoId}::uuid ORDER BY e.edited_at DESC, e.id DESC LIMIT ${limit}`;
      return rows.map((r) => ({ id: r.id, photoId: r.photo_id, batchId: r.batch_id, field: r.field, oldValue: r.old_value, newValue: r.new_value, oldSource: r.old_source, newSource: r.new_source, kind: r.kind, revertsId: r.reverts_id, editedAt: r.edited_at.toISOString(), undone: r.undone }));
    });
  }

  /** Reverts one edit to its previous value and provenance. Refused if the value has changed since (never silently overwrites newer work). */
  async undo(userId: string, photoId: string, editId: string): Promise<UndoOutcome> {
    return withUser(this.sql, userId, async (tx) => {
      const [e] = await tx<Array<{ id: string; field: EditField; old_value: unknown; new_value: unknown; old_source: string | null; new_source: string | null; kind: string; old_offset_min: number | null; new_offset_min: number | null }>>`
        SELECT id, field, old_value, new_value, old_source, new_source, kind, old_offset_min, new_offset_min FROM photo_edits WHERE id = ${editId}::uuid AND photo_id = ${photoId}::uuid`;
      if (!e) return { status: 'not_found' as const };
      if (e.kind === 'UNDO') return { status: 'is_undo' as const };
      const [done] = await tx`SELECT 1 FROM photo_edits WHERE reverts_id = ${editId}::uuid`;
      if (done) return { status: 'already_undone' as const };
      const cur = await this.load(tx, photoId);
      if (!cur) return { status: 'not_found' as const };
      const now = this.valueOf(cur, e.field);
      if (JSON.stringify(now) !== JSON.stringify(e.new_value ?? null)) return { status: 'conflict' as const };
      if (e.field === 'current_version') return { status: 'conflict' as const };                 // versions are restored from the Versions list
      await this.apply(tx, photoId, cur, e.field, e.old_value ?? null, e.old_source ?? 'USER_DEFINED', e.old_offset_min);
      await tx`INSERT INTO photo_edits (user_id, photo_id, field, old_value, new_value, old_source, new_source, kind, reverts_id, old_offset_min, new_offset_min)
               VALUES (${userId}, ${photoId}::uuid, ${e.field}, ${tx.json((e.new_value ?? null) as never)}, ${tx.json((e.old_value ?? null) as never)}, ${e.new_source}, ${e.old_source}, 'UNDO', ${editId}::uuid, ${e.new_offset_min}, ${e.old_offset_min})`;
      return { status: 'ok' as const };
    });
  }

  private valueOf(cur: Current, field: EditField): unknown {
    switch (field) {
      case 'title': return cur.title; case 'description': return cur.description; case 'notes': return cur.notes; case 'trip_location': return cur.trip_location;
      case 'capture_at': return iso(cur.capture_at);
      case 'gps': return gpsValue(cur);
      default: return undefined;
    }
  }

  // ---------------------------------------------------------------- versions
  async versions(userId: string, photoId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [p] = await tx<{ current_version_id: string }[]>`SELECT current_version_id FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL`;
      if (!p) return null;
      const rows = await tx<Array<{ id: string; version_no: number; state: string; source_relpath: string; source_present: boolean; width: number | null; height: number | null; bytes: string | null; ingested_at: Date; exported_at: Date | null; sha: string; deriv_status: string }>>`
        SELECT id, version_no, state, source_relpath, source_present, width, height, bytes, ingested_at, exported_at, encode(substring(content_sha256 from 1 for 6), 'hex') AS sha, deriv_status
          FROM photo_versions WHERE photo_id = ${photoId}::uuid ORDER BY version_no DESC`;
      return rows.map((r) => ({
        id: r.id, versionNo: r.version_no, state: r.state, relativePath: r.source_relpath, sourcePresent: r.source_present, width: r.width, height: r.height,
        bytes: r.bytes === null ? null : Number(r.bytes), importedAt: r.ingested_at.toISOString(), exportedAt: r.exported_at?.toISOString() ?? null, sha256Prefix: r.sha, derivStatus: r.deriv_status, current: r.id === p.current_version_id,
      }));
    });
  }

  /** Makes an earlier version the current one (the previous current becomes SUPERSEDED). User data stays on the photograph. */
  async restoreVersion(userId: string, photoId: string, versionId: string): Promise<RestoreOutcome> {
    return withUser(this.sql, userId, async (tx) => {
      const [p] = await tx<{ current_version_id: string }[]>`SELECT current_version_id FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      const [v] = await tx<{ id: string; version_no: number }[]>`SELECT id, version_no FROM photo_versions WHERE id = ${versionId}::uuid AND photo_id = ${photoId}::uuid`;
      if (!p || !v) return { status: 'not_found' as const };
      if (p.current_version_id === v.id) return { status: 'ok' as const, changed: false };
      await tx`UPDATE photo_versions SET state = 'SUPERSEDED' WHERE photo_id = ${photoId}::uuid AND state = 'ACTIVE'`;
      await tx`UPDATE photo_versions SET state = 'ACTIVE' WHERE id = ${versionId}::uuid`;
      await tx`UPDATE photos SET current_version_id = ${versionId}::uuid WHERE id = ${photoId}::uuid`;
      await tx`INSERT INTO photo_edits (user_id, photo_id, field, old_value, new_value, kind) VALUES (${userId}, ${photoId}::uuid, 'current_version', ${tx.json({ versionId: p.current_version_id })}, ${tx.json({ versionId, versionNo: v.version_no })}, 'EDIT')`;
      return { status: 'ok' as const, changed: true };
    });
  }

  // ---------------------------------------------------------------- bulk metadata
  /** Sets (or clears) the location name for many photographs at once; each change is recorded per photograph. */
  async bulkLocation(userId: string, target: { ids: string[] } | { query: Filters; exclude: string[] }, location: string | null, geo?: GeoLookup): Promise<{ updated: number; positioned: number; geocode?: GeocodeInfo }> {
    return withUser(this.sql, userId, async (tx) => {
      const scope = 'ids' in target
        ? tx`p.id = ANY(${target.ids}::uuid[]) AND p.deleted_at IS NULL`
        : tx`p.id IN (SELECT p.id FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${whereFor(tx, FiltersSchema.parse(target.query))} AND p.id <> ALL(${target.exclude}::uuid[]))`;
      const next = none(location);
      const batch = randomUUID();
      await tx`INSERT INTO photo_edits (user_id, photo_id, batch_id, field, old_value, new_value, old_source, new_source, kind)
               SELECT p.user_id, p.id, ${batch}::uuid, 'trip_location', to_jsonb(p.trip_location), ${tx.json(next as never)}, p.trip_location_source, ${next === null ? null : 'USER_DEFINED'}, 'BULK'
                 FROM photos p WHERE ${scope} AND p.trip_location IS DISTINCT FROM ${next}::text`;
      const rows = await tx`UPDATE photos p SET trip_location = ${next}, trip_location_source = ${next === null ? null : 'USER_DEFINED'}::meta_source
                             WHERE ${scope} AND p.trip_location IS DISTINCT FROM ${next}::text RETURNING p.id`;
      // positions: the centre of the place goes only onto photographs that have no exact position; clearing the text removes only positions that came from a lookup
      let positioned = 0; let geocode: GeocodeInfo | undefined;
      const inScope = geo ? await tx<{ id: string }[]>`SELECT p.id FROM photos p WHERE ${scope} AND p.deleted_at IS NULL` : [];       // photographs whose text already matched are placed too
      if (inScope.length > 0 && geo) {
        const ids = inScope.map((r) => r.id);
        const soft = tx`p.id = ANY(${ids}::uuid[]) AND (v.gps_source IS NULL OR v.gps_source IN ('GEOCODED','FOLDER_DERIVED','AI_INFERRED'))`;
        if (next === null) {
          const rec = await tx`INSERT INTO photo_edits (user_id, photo_id, batch_id, field, old_value, new_value, old_source, new_source, kind)
            SELECT p.user_id, p.id, ${batch}::uuid, 'gps', jsonb_build_object('lat', v.gps_lat, 'lon', v.gps_lon, 'label', v.gps_label), 'null'::jsonb, v.gps_source, NULL, 'BULK'
              FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${soft} AND v.gps_source = 'GEOCODED' RETURNING 1`;
          await tx`UPDATE photo_versions v SET gps_lat = NULL, gps_lon = NULL, gps_source = NULL, gps_label = NULL FROM photos p WHERE p.current_version_id = v.id AND ${soft} AND v.gps_source = 'GEOCODED'`;
          positioned = rec.length; geocode = { status: 'cleared', query: '' };
        } else if (geo.result.status === 'ok') {
          const c = geo.result.candidates[0]!;
          await tx`INSERT INTO photo_edits (user_id, photo_id, batch_id, field, old_value, new_value, old_source, new_source, kind)
            SELECT p.user_id, p.id, ${batch}::uuid, 'gps', CASE WHEN v.gps_lat IS NULL THEN 'null'::jsonb WHEN v.gps_source = 'GEOCODED' AND v.gps_label IS NOT NULL THEN jsonb_build_object('lat', v.gps_lat, 'lon', v.gps_lon, 'label', v.gps_label) ELSE jsonb_build_object('lat', v.gps_lat, 'lon', v.gps_lon) END,
                   ${tx.json({ lat: c.lat, lon: c.lon, label: c.label } as never)}, v.gps_source, 'GEOCODED', 'BULK'
              FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${soft}`;
          const upd = await tx`UPDATE photo_versions v SET gps_lat = ${c.lat}, gps_lon = ${c.lon}, gps_source = 'GEOCODED', gps_label = ${c.label} FROM photos p WHERE p.current_version_id = v.id AND ${soft} RETURNING 1`;
          positioned = upd.length; geocode = { status: 'placed', query: next, label: c.label, lat: c.lat, lon: c.lon };
        } else {
          geocode = geo.result.status === 'not_found' ? { status: 'not_found', query: next ?? '', message: `“${next}” was not found on the map; the text was kept.` } : geo.result.status === 'disabled' ? { status: 'disabled', query: next ?? '', message: 'Looking places up is switched off; the text was kept.' } : { status: 'unavailable', query: next ?? '', message: `${geo.result.reason}. The text was kept.` };
        }
      }
      return { updated: rows.length, positioned, ...(geocode ? { geocode } : {}) };
    });
  }

  // ---------------------------------------------------------------- place names typed earlier that never got a position
  /** The distinct place names YOU typed (not folder names) on photographs that have no position yet, most used first. */
  async unplacedNames(userId: string, limit = 20): Promise<Array<{ text: string; photos: number }>> {
    return withUser(this.sql, userId, async (tx) => (await tx<Array<{ text: string; n: number }>>`
      SELECT p.trip_location AS text, count(*)::int AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
       WHERE p.deleted_at IS NULL AND p.trip_location IS NOT NULL AND p.trip_location_source = 'USER_DEFINED' AND v.gps_lat IS NULL
       GROUP BY p.trip_location ORDER BY n DESC, p.trip_location LIMIT ${limit}`).map((r) => ({ text: r.text, photos: r.n })));
  }

  /** Puts every photograph that carries exactly this typed place name and has no position at the centre of the place found. Never touches a photograph that has any position. */
  async placeNamed(userId: string, text: string, geo: GeoLookup): Promise<{ query: string; status: GeocodeInfo['status']; label?: string; photos: number; message?: string }> {
    if (geo.result.status !== 'ok') {
      const status = geo.result.status === 'not_found' ? 'not_found' : geo.result.status === 'disabled' ? 'disabled' : 'unavailable';
      return { query: text, status, photos: 0, message: geo.result.status === 'unavailable' ? geo.result.reason : undefined };
    }
    const c = geo.result.candidates[0]!;
    return withUser(this.sql, userId, async (tx) => {
      const batch = randomUUID();
      const scope = tx`p.deleted_at IS NULL AND p.trip_location = ${text} AND p.trip_location_source = 'USER_DEFINED' AND v.gps_lat IS NULL`;
      await tx`INSERT INTO photo_edits (user_id, photo_id, batch_id, field, old_value, new_value, old_source, new_source, kind)
        SELECT p.user_id, p.id, ${batch}::uuid, 'gps', 'null'::jsonb, ${tx.json({ lat: c.lat, lon: c.lon, label: c.label } as never)}, NULL, 'GEOCODED', 'BULK'
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${scope}`;
      const upd = await tx`UPDATE photo_versions v SET gps_lat = ${c.lat}, gps_lon = ${c.lon}, gps_source = 'GEOCODED', gps_label = ${c.label} FROM photos p WHERE p.current_version_id = v.id AND ${scope} RETURNING 1`;
      return { query: text, status: 'placed' as const, label: c.label, photos: upd.length };
    });
  }
}
