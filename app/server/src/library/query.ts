import type { PendingQuery, Row, Sql } from 'postgres';
import { z } from 'zod';

/**
 * The Library's query language. Everything the UI can ask for is validated here and turned into parameterised SQL;
 * nothing is ever filtered in the browser. Row-level security (app.user_id) is applied by PostgreSQL on top of this.
 */
export const VIEWS = ['all', 'recent', 'favorites', 'rated', 'portfolio', 'published', 'never', 'unreviewed'] as const;
export const SORTS = ['captured', 'imported', 'filename', 'rating', 'modified'] as const;
export type View = (typeof VIEWS)[number];
export type SortKey = (typeof SORTS)[number];

/** Querystrings carry repeated keys (?year=2024&year=2023); JSON bodies carry arrays. Both normalise to an array. */
const list = <T extends z.ZodTypeAny>(item: T, max = 40) =>
  z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(item).max(max).optional());
const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());
const text = (n: number) => z.string().trim().min(1).max(n);
/** west,south,east,north in degrees. A query string carries "w,s,e,n"; a JSON body carries four numbers. The box may not cross the antimeridian. */
const bboxSchema = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((x) => (x.trim() === '' ? NaN : Number(x))) : v),
  z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
    .refine(([w, s, e, n]) => w <= e && s <= n, 'the box must run west→east and south→north').optional());
export const GPS_SOURCES = ['FOLDER_DERIVED', 'EXIF', 'IPTC', 'USER_DEFINED', 'AI_INFERRED', 'GEOCODED'] as const;

export const FilterShape = {
  view: z.enum(VIEWS).default('all'),
  /** CAPTURE year (from the EXIF capture time). Photographs without a capture time never match. */
  year: list(z.coerce.number().int().min(1826).max(2200)),
  /** the year of the folder the file sits in (`2025/Kenya/…`), independent of when the photograph was taken */
  folderYear: list(z.coerce.number().int().min(1826).max(2200)),
  /** a folder of the original library (`2025/Kenya` or `2025/Kenya/Day 2`): everything inside it, at any depth */
  folder: list(z.string().trim().min(1).max(300).refine((x) => !x.startsWith('/') && !x.split('/').includes('..'), 'a relative folder path'), 10),
  /** folder location (`2025/Kenya/…` → Kenya) */
  location: list(text(120)),
  /** folder location OR any IPTC/XMP place name (city, state, country, code, sublocation) — what a place word in a search means */
  place: list(text(120)),
  /** IPTC/XMP place names; case-insensitive. `country` matches the name or the ISO code. */
  city: list(text(120)), state: list(text(120)), country: list(text(120)),
  /** Lightroom colour label */
  label: list(text(30), 8),
  rating: list(z.coerce.number().int().min(0).max(5), 6),
  favorite: flag,
  portfolio: flag,
  ig: list(z.enum(['posted', 'never', 'draft', 'scheduled', 'possible']), 5),
  orientation: list(z.enum(['landscape', 'portrait', 'square']), 3),
  bbox: bboxSchema,
  /** where the coordinates came from, or 'none' for photographs without any */
  gps: list(z.enum([...GPS_SOURCES, 'none']), 6),
  month: list(z.coerce.number().int().min(1).max(12), 12),
  species: list(text(120)),
  colour: list(text(30), 14),
  tag: list(text(60), 12),
  camera: list(text(120)),
  lens: list(text(160)),
  ai: list(z.enum(['analyzed', 'queued', 'failed', 'none']), 4),
  q: z.string().trim().max(120).optional(),
  /** true = show ONLY hidden photographs (the default library never shows them) */
  hidden: flag,
  dup: list(z.enum(['open']), 1),
};
export const FiltersSchema = z.object(FilterShape).strict();
export type Filters = z.infer<typeof FiltersSchema>;

export const ListSchema = z.object({
  ...FilterShape,
  sort: z.enum(SORTS).default('captured'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(300).default(120),
  cursor: z.string().max(600).optional(),
}).strict();
export type ListParams = z.infer<typeof ListSchema>;

const Cursor = z.object({ v: z.union([z.string().max(300), z.number().int(), z.null()]), id: z.string().uuid() });
export type CursorValue = z.infer<typeof Cursor>;
export const encodeCursor = (c: CursorValue): string => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(s: string): CursorValue | null {
  try { const r = Cursor.safeParse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))); return r.success ? r.data : null; } catch { return null; }
}

type Frag = PendingQuery<Row[]>;
const and = (tx: Sql, parts: Frag[]): Frag => parts.length === 0 ? tx`true` : parts.reduce((acc, p, i) => (i === 0 ? p : tx`${acc} AND ${p}`));
const or = (tx: Sql, parts: Frag[]): Frag => parts.reduce((acc, p, i) => (i === 0 ? p : tx`${acc} OR ${p}`));
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Camera label shown to people and used by the facet/filter: the model, prefixed with the make (without a trailing "CORPORATION"/"CO., LTD.") unless the model already carries it. */
export const cameraLabel = (tx: Sql): Frag =>
  tx`(CASE WHEN v.camera_model IS NULL THEN NULL
           WHEN v.camera_make IS NULL THEN v.camera_model
           WHEN v.camera_model ILIKE regexp_replace(v.camera_make, '\\s+(corporation|corp\\.?|co\\.?,?\\s*ltd\\.?|company|inc\\.?)$', '', 'i') || '%' THEN v.camera_model
           ELSE regexp_replace(v.camera_make, '\\s+(corporation|corp\\.?|co\\.?,?\\s*ltd\\.?|company|inc\\.?)$', '', 'i') || ' ' || v.camera_model END)`;

const POSTED_STATES = ['EXACT_MATCH', 'HIGH_CONFIDENCE_MATCH', 'USER_CONFIRMED'];
const postedExists = (tx: Sql): Frag => tx`EXISTS (SELECT 1 FROM photo_social_matches m WHERE m.user_id = p.user_id AND m.photo_id = p.id AND m.state = ANY(${POSTED_STATES}::text[]))`;
const possibleExists = (tx: Sql): Frag => tx`EXISTS (SELECT 1 FROM photo_social_matches m WHERE m.user_id = p.user_id AND m.photo_id = p.id AND m.state = 'POSSIBLE_MATCH')`;
const draftExists = (tx: Sql): Frag => tx`EXISTS (SELECT 1 FROM publishing_drafts d WHERE d.user_id = p.user_id AND d.photo_id = p.id AND d.state IN ('DRAFT','READY'))`;
const scheduledExists = (tx: Sql): Frag => tx`EXISTS (SELECT 1 FROM publishing_drafts d JOIN scheduled_publications s ON s.draft_id = d.id WHERE d.user_id = p.user_id AND d.photo_id = p.id AND s.state IN ('SCHEDULED','PUBLISHING'))`;
const aiJobPhotoIds = (tx: Sql, states: string[]): Frag => tx`SELECT (j.payload ->> 'photoId')::uuid FROM jobs j WHERE j.kind = 'ai.analyze' AND j.state = ANY(${states}::text[]) AND j.payload ->> 'photoId' IS NOT NULL`;
const analysed = (tx: Sql): Frag => tx`EXISTS (SELECT 1 FROM ai_analyses a WHERE a.user_id = p.user_id AND a.photo_version_id = v.id)`;

/** The WHERE clause for a set of filters. Aliases: p = photos, v = the photo's current version. */
export function whereFor(tx: Sql, f: Filters, extra: Frag[] = []): Frag {
  const w: Frag[] = [...extra, tx`p.deleted_at IS NULL`, f.hidden === true ? tx`p.hidden` : tx`NOT p.hidden`];
  switch (f.view) {
    case 'recent': w.push(tx`v.ingested_at >= now() - interval '30 days'`); break;
    case 'favorites': w.push(tx`p.favorite`); break;
    case 'rated': w.push(tx`p.rating > 0`); break;
    case 'portfolio': w.push(tx`p.portfolio_candidate`); break;
    case 'published': w.push(postedExists(tx)); break;
    case 'never': w.push(tx`NOT ${postedExists(tx)}`); break;
    case 'unreviewed': w.push(tx`p.rating = 0 AND NOT p.favorite AND NOT p.portfolio_candidate`); break;
    default: break;
  }
  if (f.year?.length) w.push(tx`p.capture_year = ANY(${f.year}::int[])`);
  if (f.folderYear?.length) w.push(tx`p.year = ANY(${f.folderYear}::int[])`);
  const lc = (a: string[]) => a.map((x) => x.toLowerCase());
  if (f.place?.length) { const l = f.place.map((x) => x.toLowerCase()); w.push(tx`(p.trip_location = ANY(${f.place}::text[]) OR lower(p.place_city) = ANY(${l}::text[]) OR lower(p.place_state) = ANY(${l}::text[]) OR lower(p.place_country) = ANY(${l}::text[]) OR lower(p.place_country_code) = ANY(${l}::text[]) OR lower(p.place_sublocation) = ANY(${l}::text[]))`); }
  if (f.folder?.length) w.push(tx`(${or(tx, f.folder.map((d) => tx`v.source_relpath LIKE ${like(d.replace(/\/+$/, '')) .slice(1, -1) + '/%'}`))})`);
  if (f.city?.length) w.push(tx`lower(p.place_city) = ANY(${lc(f.city)}::text[])`);
  if (f.state?.length) w.push(tx`lower(p.place_state) = ANY(${lc(f.state)}::text[])`);
  if (f.country?.length) w.push(tx`(lower(p.place_country) = ANY(${lc(f.country)}::text[]) OR lower(p.place_country_code) = ANY(${lc(f.country)}::text[]))`);
  if (f.label?.length) w.push(tx`lower(p.color_label) = ANY(${lc(f.label)}::text[])`);
  if (f.bbox) w.push(tx`(v.gps_lat BETWEEN ${f.bbox[1]} AND ${f.bbox[3]} AND v.gps_lon BETWEEN ${f.bbox[0]} AND ${f.bbox[2]})`);
  if (f.gps?.length) {
    const src = f.gps.filter((x) => x !== 'none');
    w.push(tx`(${or(tx, [...(f.gps.includes('none') ? [tx`v.gps_lat IS NULL`] : []), ...(src.length ? [tx`v.gps_source = ANY(${src}::text[])`] : [])])})`);
  }
  if (f.month?.length) w.push(tx`p.capture_month = ANY(${f.month}::int[])`);
  if (f.species?.length) w.push(tx`EXISTS (SELECT 1 FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = p.id AND ps.status <> 'REJECTED' AND s.common_name = ANY(${f.species}::text[]))`);
  if (f.colour?.length) w.push(tx`EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = v.id AND a.dominant_color_names && ${f.colour}::text[])`);
  if (f.tag?.length) w.push(tx`EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = v.id AND a.tags @> ${f.tag}::text[])`);
  if (f.location?.length) w.push(tx`p.trip_location = ANY(${f.location}::text[])`);
  if (f.rating?.length) w.push(tx`p.rating = ANY(${f.rating}::int[])`);
  if (f.favorite !== undefined) w.push(f.favorite ? tx`p.favorite` : tx`NOT p.favorite`);
  if (f.portfolio !== undefined) w.push(f.portfolio ? tx`p.portfolio_candidate` : tx`NOT p.portfolio_candidate`);
  if (f.orientation?.length) {
    const o: Record<string, Frag> = {
      landscape: tx`v.width > v.height * 1.03`,
      portrait: tx`v.height > v.width * 1.03`,
      square: tx`(v.width <= v.height * 1.03 AND v.height <= v.width * 1.03)`,
    };
    w.push(tx`(${or(tx, f.orientation.map((x) => o[x]!))})`);
  }
  if (f.camera?.length) w.push(tx`${cameraLabel(tx)} = ANY(${f.camera}::text[])`);
  if (f.lens?.length) w.push(tx`v.lens = ANY(${f.lens}::text[])`);
  if (f.ig?.length) {
    const g: Record<string, Frag> = {
      posted: postedExists(tx), never: tx`NOT ${postedExists(tx)}`, draft: draftExists(tx), scheduled: scheduledExists(tx), possible: possibleExists(tx),
    };
    w.push(tx`(${or(tx, f.ig.map((x) => g[x]!))})`);
  }
  if (f.dup?.length) w.push(tx`EXISTS (SELECT 1 FROM duplicate_pairs d WHERE d.user_id = p.user_id AND d.state = 'OPEN' AND (d.photo_a = p.id OR d.photo_b = p.id))`);
  if (f.ai?.length) {
    const a: Record<string, Frag> = {
      analyzed: analysed(tx),
      queued: tx`(NOT ${analysed(tx)} AND p.id IN (${aiJobPhotoIds(tx, ['QUEUED', 'RUNNING'])}))`,
      failed: tx`(NOT ${analysed(tx)} AND p.id IN (${aiJobPhotoIds(tx, ['FAILED', 'DEAD'])}) AND p.id NOT IN (${aiJobPhotoIds(tx, ['QUEUED', 'RUNNING'])}))`,
      none: tx`(NOT ${analysed(tx)} AND p.id NOT IN (${aiJobPhotoIds(tx, ['QUEUED', 'RUNNING', 'FAILED', 'DEAD'])}))`,
    };
    w.push(tx`(${or(tx, f.ai.map((x) => a[x]!))})`);
  }
  if (f.q) {
    const pat = like(f.q);
    // partial, case-insensitive: title, path, folder place, camera, lens, IPTC place names, creator, keywords
    w.push(tx`(p.title ILIKE ${pat} OR v.source_relpath ILIKE ${pat} OR p.trip_location ILIKE ${pat} OR v.camera_model ILIKE ${pat} OR v.camera_make ILIKE ${pat} OR v.lens ILIKE ${pat}
               OR p.place_city ILIKE ${pat} OR p.place_state ILIKE ${pat} OR p.place_country ILIKE ${pat} OR p.place_country_code ILIKE ${pat} OR p.place_sublocation ILIKE ${pat} OR v.photographer ILIKE ${pat}
               OR array_to_string(v.keywords, ' ') ILIKE ${pat} OR array_to_string(v.keywords_hier, ' ') ILIKE ${pat})`);
  }
  return and(tx, w);
}

interface SortDef { expr: (tx: Sql) => Frag; cast: 'timestamptz' | 'text' | 'int'; nullable: boolean }
export const SORT_DEFS: Record<SortKey, SortDef> = {
  captured: { expr: (tx) => tx`p.capture_at`, cast: 'timestamptz', nullable: true },
  imported: { expr: (tx) => tx`v.ingested_at`, cast: 'timestamptz', nullable: false },
  filename: { expr: (tx) => tx`lower(regexp_replace(v.source_relpath, '^.*/', ''))`, cast: 'text', nullable: false },
  rating: { expr: (tx) => tx`p.rating`, cast: 'int', nullable: false },
  modified: { expr: (tx) => tx`p.updated_at`, cast: 'timestamptz', nullable: false },
};

// NOTE the ::text hop: a parameter typed timestamptz is serialised by the driver through a JavaScript Date (millisecond precision), which would
// round the cursor and repeat the boundary row for timestamps written by now() (microseconds). Parsing the text inside PostgreSQL is exact.
const castValue = (tx: Sql, cast: SortDef['cast'], v: string | number): Frag =>
  cast === 'int' ? tx`${Number(v)}::int` : cast === 'text' ? tx`${String(v)}::text` : tx`${String(v)}::text::timestamptz`;

/**
 * Keyset predicate "strictly after the cursor row" for the chosen sort. NULL sort values (undated photographs) always come last.
 * Keyset (not OFFSET) pagination keeps page N as cheap as page 1 and stable while the data changes underneath.
 */
export function afterCursor(tx: Sql, sort: SortKey, dir: 'asc' | 'desc', c: CursorValue): Frag {
  const d = SORT_DEFS[sort]; const expr = d.expr(tx);
  const lt = dir === 'desc';
  const idCmp = lt ? tx`p.id < ${c.id}::uuid` : tx`p.id > ${c.id}::uuid`;
  if (c.v === null) return tx`(${expr} IS NULL AND ${idCmp})`;
  const val = castValue(tx, d.cast, c.v);
  const strict = lt ? tx`${expr} < ${val}` : tx`${expr} > ${val}`;
  const core = tx`(${strict} OR (${expr} = ${val} AND ${idCmp}))`;
  return d.nullable ? tx`(${core} OR ${expr} IS NULL)` : core;
}

export const orderBy = (tx: Sql, sort: SortKey, dir: 'asc' | 'desc'): Frag => {
  const expr = SORT_DEFS[sort].expr(tx);
  return dir === 'desc' ? tx`${expr} DESC NULLS LAST, p.id DESC` : tx`${expr} ASC NULLS LAST, p.id ASC`;
};

/** Default order for each predefined view (the UI may override). */
export const DEFAULT_SORT: Record<View, { sort: SortKey; dir: 'asc' | 'desc' }> = {
  all: { sort: 'captured', dir: 'desc' }, recent: { sort: 'imported', dir: 'desc' }, favorites: { sort: 'captured', dir: 'desc' },
  rated: { sort: 'rating', dir: 'desc' }, portfolio: { sort: 'captured', dir: 'desc' }, published: { sort: 'captured', dir: 'desc' },
  never: { sort: 'captured', dir: 'desc' }, unreviewed: { sort: 'captured', dir: 'desc' },
};
