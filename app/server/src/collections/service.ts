import type { PendingQuery, Row as PgRow, Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { FiltersSchema, whereFor, type Filters } from '../library/query.js';
import type { LibraryService, PhotoCard } from '../library/service.js';
import { SearchSchema, type SearchService } from '../search/service.js';

export const MOVE_LIMIT = 20_000;
export const KINDS = ['MANUAL', 'SMART', 'SAVED_SEARCH', 'AI_DRAFT', 'PORTFOLIO', 'PUBLISHING'] as const;
type Frag = PendingQuery<PgRow[]>;
const Uuid = z.string().uuid();
const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(500).nullable();

export const CreateSchema = z.object({
  name, description: description.optional(), kind: z.enum(['MANUAL', 'SMART']).default('MANUAL'),
  filters: FiltersSchema.optional(), ids: z.array(Uuid).max(500).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'SMART' && !v.filters) ctx.addIssue({ code: 'custom', message: 'a smart collection needs filters', path: ['filters'] });
  if (v.kind === 'MANUAL' && v.filters) ctx.addIssue({ code: 'custom', message: 'filters belong to smart collections', path: ['filters'] });
  if (v.kind === 'SMART' && v.ids) ctx.addIssue({ code: 'custom', message: 'a smart collection has no fixed members', path: ['ids'] });
});
export const PatchSchema = z.object({ name: name.optional(), description: description.optional(), coverPhotoId: Uuid.nullable().optional(), filters: FiltersSchema.optional() })
  .strict().refine((v) => Object.keys(v).length > 0, 'nothing to change');
export const TargetSchema = z.union([
  z.object({ ids: z.array(Uuid).min(1).max(500) }).strict(),
  z.object({ query: FiltersSchema, exclude: z.array(Uuid).max(1000).default([]) }).strict(),
]);
export const MoveSchema = z.object({ ids: z.array(Uuid).min(1).max(500), before: Uuid.nullable() }).strict();

export interface CollectionView {
  id: string; name: string; description: string | null; kind: string; status: string; createdBy: string; rationale: string | null;
  count: number | null; cover: string | null; coverIsChosen: boolean; dynamic: boolean; filters: Filters | null; search: { q: string; exclude: string[] } | null; updatedAt: string; createdAt: string;
}
interface Row { id: string; name: string; description: string | null; kind: string; status: string; created_by: string; rationale: string | null; query: unknown; cover_photo_id: string | null; created_at: Date; updated_at: Date; n: number | null; first_photo: string | null }
export interface CollectionPage { items: PhotoCard[]; total: number; nextCursor: string | null }
export type Outcome<T> = { ok: true; value: T } | { ok: false; code: 'not_found' | 'conflict' | 'invalid' | 'name_in_use'; message: string };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (code: Extract<Outcome<never>, { ok: false }>['code'], message: string): Outcome<never> => ({ ok: false, code, message });
const isDynamic = (kind: string) => kind === 'SMART' || kind === 'SAVED_SEARCH';

export class CollectionService {
  constructor(private readonly sql: Sql, private readonly library: LibraryService, private readonly search: SearchService) {}

  private async rows(tx: Sql, where: Frag): Promise<Row[]> {
    return tx<Row[]>`
      SELECT c.id, c.name, c.description, c.kind, c.status, c.created_by, c.rationale, c.query, c.cover_photo_id, c.created_at, c.updated_at,
             CASE WHEN c.kind IN ('SMART','SAVED_SEARCH') THEN NULL ELSE (SELECT count(*)::int FROM collection_photos cp JOIN photos p ON p.id = cp.photo_id WHERE cp.collection_id = c.id AND p.deleted_at IS NULL AND NOT p.hidden) END AS n,
             CASE WHEN c.kind IN ('SMART','SAVED_SEARCH') THEN NULL ELSE (SELECT cp.photo_id FROM collection_photos cp JOIN photos p ON p.id = cp.photo_id WHERE cp.collection_id = c.id AND p.deleted_at IS NULL AND NOT p.hidden ORDER BY cp.position, cp.added_at LIMIT 1) END AS first_photo
        FROM collections c WHERE ${where} ORDER BY lower(c.name)`;
  }

  /** Dynamic collections have no stored members: their count and cover come from running the stored query now. */
  private async view(userId: string, r: Row): Promise<CollectionView> {
    const q = r.query as { filters?: Filters; q?: string; exclude?: string[] } | null;
    let count = r.n; let cover = r.cover_photo_id ?? r.first_photo;
    const base = {
      id: r.id, name: r.name, description: r.description, kind: r.kind, status: r.status, createdBy: r.created_by, rationale: r.rationale, dynamic: isDynamic(r.kind),
      filters: r.kind === 'SMART' ? (q?.filters ?? null) : null, search: r.kind === 'SAVED_SEARCH' ? { q: q?.q ?? '', exclude: q?.exclude ?? [] } : null,
      coverIsChosen: r.cover_photo_id !== null, updatedAt: r.updated_at.toISOString(), createdAt: r.created_at.toISOString(),
    };
    if (r.kind === 'SMART' && q?.filters) {
      try { const page = await this.library.list(userId, { ...FiltersSchema.parse(q.filters), sort: 'captured', dir: 'desc', limit: 1 }); if (!('invalidCursor' in page)) { count = page.total ?? 0; cover = r.cover_photo_id ?? page.items[0]?.id ?? null; } } catch { /* a stored query that no longer parses shows as empty */ }
    } else if (r.kind === 'SAVED_SEARCH') {
      try { const res = await this.search.search(userId, SearchSchema.parse({ q: q?.q || 'a', exclude: q?.exclude ?? [], limit: 1 })); count = res.total; cover = r.cover_photo_id ?? res.items[0]?.id ?? null; } catch { /* as above */ }
    }
    return { ...base, count, cover };
  }

  async list(userId: string, status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' = 'ACTIVE'): Promise<CollectionView[]> {
    const rows = await withUser(this.sql, userId, (tx) => this.rows(tx, tx`c.status = ${status}`));
    return Promise.all(rows.map((r) => this.view(userId, r)));
  }
  async get(userId: string, id: string): Promise<CollectionView | null> {
    const rows = await withUser(this.sql, userId, (tx) => this.rows(tx, tx`c.id = ${id}::uuid`));
    return rows[0] ? this.view(userId, rows[0]) : null;
  }

  async create(userId: string, c: z.infer<typeof CreateSchema>): Promise<Outcome<{ id: string }>> {
    try {
      return await withUser(this.sql, userId, async (tx) => {
        const query = c.kind === 'SMART' ? tx.json({ filters: c.filters } as never) : null;
        const [r] = await tx<{ id: string }[]>`INSERT INTO collections (user_id, name, description, kind, query) VALUES (${userId}, ${c.name}, ${c.description ?? null}, ${c.kind}, ${query}) RETURNING id`;
        if (c.ids?.length) await this.insertMembers(tx, userId, r!.id, tx`SELECT p.id, array_position(${c.ids}::uuid[], p.id) AS ord FROM photos p WHERE p.id = ANY(${c.ids}::uuid[]) AND p.deleted_at IS NULL`);
        return ok({ id: r!.id });
      });
    } catch (e) { if ((e as { code?: string }).code === '23505') return fail('name_in_use', 'A collection with that name already exists.'); throw e; }
  }

  async update(userId: string, id: string, p: z.infer<typeof PatchSchema>): Promise<Outcome<null>> {
    try {
      return await withUser(this.sql, userId, async (tx) => {
        const [c] = await tx<{ kind: string }[]>`SELECT kind FROM collections WHERE id = ${id}::uuid FOR UPDATE`;
        if (!c) return fail('not_found', 'No such collection.');
        if (p.filters && c.kind !== 'SMART') return fail('invalid', 'Only smart collections have filters.');
        if (p.coverPhotoId) {
          const [m] = isDynamic(c.kind)
            ? await tx`SELECT 1 FROM photos WHERE id = ${p.coverPhotoId}::uuid AND deleted_at IS NULL`
            : await tx`SELECT 1 FROM collection_photos WHERE collection_id = ${id}::uuid AND photo_id = ${p.coverPhotoId}::uuid`;
          if (!m) return fail('invalid', isDynamic(c.kind) ? 'No such photograph.' : 'The cover must be a photograph in the collection.');
        }
        await tx`UPDATE collections SET name = coalesce(${p.name ?? null}, name),
                   description = CASE WHEN ${p.description !== undefined} THEN ${p.description ?? null} ELSE description END,
                   cover_photo_id = CASE WHEN ${p.coverPhotoId !== undefined} THEN ${p.coverPhotoId ?? null}::uuid ELSE cover_photo_id END,
                   query = CASE WHEN ${p.filters !== undefined} THEN ${tx.json({ filters: p.filters } as never)} ELSE query END WHERE id = ${id}::uuid`;
        return ok(null);
      });
    } catch (e) { if ((e as { code?: string }).code === '23505') return fail('name_in_use', 'A collection with that name already exists.'); throw e; }
  }

  /** Removes the collection and its membership list. Photographs are never touched. */
  async remove(userId: string, id: string): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => (await tx`DELETE FROM collections WHERE id = ${id}::uuid RETURNING id`).length === 1);
  }

  async setState(userId: string, id: string, action: 'activate' | 'archive'): Promise<Outcome<null>> {
    return withUser(this.sql, userId, async (tx) => {
      const [c] = await tx<{ kind: string; status: string }[]>`SELECT kind, status FROM collections WHERE id = ${id}::uuid FOR UPDATE`;
      if (!c) return fail('not_found', 'No such collection.');
      if (action === 'archive') { await tx`UPDATE collections SET status = 'ARCHIVED' WHERE id = ${id}::uuid`; return ok(null); }
      if (c.status === 'ACTIVE') return ok(null);
      // an AI draft becomes an ordinary manual collection only when a person activates it
      await tx`UPDATE collections SET status = 'ACTIVE', kind = CASE WHEN kind = 'AI_DRAFT' THEN 'MANUAL' ELSE kind END WHERE id = ${id}::uuid`;
      return ok(null);
    });
  }

  async photos(userId: string, id: string, cursor: string | undefined, limit: number): Promise<Outcome<CollectionPage>> {
    const [meta] = await withUser(this.sql, userId, (tx) => tx<{ kind: string; query: unknown }[]>`SELECT kind, query FROM collections WHERE id = ${id}::uuid`);
    if (!meta) return fail('not_found', 'No such collection.');
    const q = meta.query as { filters?: Filters; q?: string; exclude?: string[] } | null;
    if (meta.kind === 'SMART') {
      const page = await this.library.list(userId, { ...FiltersSchema.parse(q?.filters ?? {}), sort: 'captured', dir: 'desc', limit, ...(cursor ? { cursor } : {}) });
      if ('invalidCursor' in page) return fail('invalid', 'The page position is no longer valid.');
      return ok({ items: page.items, total: page.total ?? 0, nextCursor: page.nextCursor });
    }
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return fail('invalid', 'The page position is not valid.');
    if (meta.kind === 'SAVED_SEARCH') {
      if (offset > 5000) return fail('invalid', 'Saved searches page up to 5,000 results.');
      const r = await this.search.search(userId, SearchSchema.parse({ q: q?.q || 'a', exclude: q?.exclude ?? [], limit, offset }));
      return ok({ items: r.items, total: r.total, nextCursor: r.nextOffset === null ? null : String(r.nextOffset) });
    }
    const { ids, total } = await withUser(this.sql, userId, async (tx) => {
      const [rows, cnt] = await Promise.all([
        tx<{ photo_id: string }[]>`SELECT cp.photo_id FROM collection_photos cp JOIN photos p ON p.id = cp.photo_id
            WHERE cp.collection_id = ${id}::uuid AND p.deleted_at IS NULL AND NOT p.hidden ORDER BY cp.position, cp.added_at, cp.photo_id OFFSET ${offset} LIMIT ${limit}`,
        tx<{ n: number }[]>`SELECT count(*)::int AS n FROM collection_photos cp JOIN photos p ON p.id = cp.photo_id WHERE cp.collection_id = ${id}::uuid AND p.deleted_at IS NULL AND NOT p.hidden`,
      ]);
      return { ids: rows.map((r) => r.photo_id), total: cnt[0]!.n };
    });
    const items = await this.library.cards(userId, ids);
    return ok({ items, total, nextCursor: offset + limit < total ? String(offset + limit) : null });
  }

  /** Appends photographs that are not already members (idempotent). Photographs of other accounts are invisible to the INSERT (row-level security). */
  private async insertMembers(tx: Sql, userId: string, id: string, source: Frag): Promise<number> {
    const rows = await tx`
      WITH base AS (SELECT coalesce(max(position) + 1, 0) AS b FROM collection_photos WHERE collection_id = ${id}::uuid),
           src AS (SELECT s.id, row_number() OVER (ORDER BY s.ord) AS rn FROM (${source}) s WHERE NOT EXISTS (SELECT 1 FROM collection_photos x WHERE x.collection_id = ${id}::uuid AND x.photo_id = s.id))
      INSERT INTO collection_photos (user_id, collection_id, photo_id, position)
      SELECT ${userId}, ${id}::uuid, src.id, (SELECT b FROM base) + src.rn - 1 FROM src ON CONFLICT DO NOTHING RETURNING photo_id`;
    return rows.length;
  }

  async add(userId: string, id: string, target: z.infer<typeof TargetSchema>): Promise<Outcome<{ added: number; alreadyIn: number }>> {
    return withUser(this.sql, userId, async (tx) => {
      const [c] = await tx<{ kind: string }[]>`SELECT kind FROM collections WHERE id = ${id}::uuid FOR UPDATE`;
      if (!c) return fail('not_found', 'No such collection.');
      if (c.kind !== 'MANUAL') return fail('conflict', 'Only manual collections have a fixed list of photographs.');
      let source: Frag; let wanted: number;
      if ('ids' in target) {
        source = tx`SELECT p.id, array_position(${target.ids}::uuid[], p.id) AS ord FROM photos p WHERE p.id = ANY(${target.ids}::uuid[]) AND p.deleted_at IS NULL`; wanted = new Set(target.ids).size;
      } else {
        const where = whereFor(tx, target.query);
        source = tx`SELECT p.id, row_number() OVER (ORDER BY p.capture_at DESC NULLS LAST, p.id DESC) AS ord FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where} AND p.id <> ALL(${target.exclude}::uuid[])`;
        wanted = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM (${source}) s`)[0]!.n;
      }
      const added = await this.insertMembers(tx, userId, id, source);
      return ok({ added, alreadyIn: Math.max(0, wanted - added) });
    });
  }

  async removeMembers(userId: string, id: string, ids: string[]): Promise<Outcome<{ removed: number }>> {
    return withUser(this.sql, userId, async (tx) => {
      const [c] = await tx<{ kind: string }[]>`SELECT kind FROM collections WHERE id = ${id}::uuid`;
      if (!c) return fail('not_found', 'No such collection.');
      if (c.kind !== 'MANUAL') return fail('conflict', 'Only manual collections have a fixed list of photographs.');
      const rows = await tx`DELETE FROM collection_photos WHERE collection_id = ${id}::uuid AND photo_id = ANY(${ids}::uuid[]) RETURNING photo_id`;
      await tx`UPDATE collections SET cover_photo_id = NULL WHERE id = ${id}::uuid AND cover_photo_id = ANY(${ids}::uuid[])`;      // a removed photograph cannot stay the cover
      return ok({ removed: rows.length });
    });
  }

  /** Moves the given photographs (keeping their relative order) in front of `before`, or to the end when `before` is null. */
  async move(userId: string, id: string, m: z.infer<typeof MoveSchema>): Promise<Outcome<{ moved: number }>> {
    return withUser(this.sql, userId, async (tx) => {
      const [c] = await tx<{ kind: string }[]>`SELECT kind FROM collections WHERE id = ${id}::uuid FOR UPDATE`;
      if (!c) return fail('not_found', 'No such collection.');
      if (c.kind !== 'MANUAL') return fail('conflict', 'Only manual collections have an order you can change.');
      const all = (await tx<{ photo_id: string }[]>`SELECT photo_id FROM collection_photos WHERE collection_id = ${id}::uuid ORDER BY position, added_at, photo_id LIMIT ${MOVE_LIMIT + 1}`).map((r) => r.photo_id);
      if (all.length > MOVE_LIMIT) return fail('conflict', 'This collection is too large to reorder here.');
      const set = new Set(all);
      const moving = m.ids.filter((x, i) => set.has(x) && m.ids.indexOf(x) === i);
      if (!moving.length) return fail('invalid', 'None of those photographs are in the collection.');
      if (m.before !== null && (!set.has(m.before) || moving.includes(m.before))) return fail('invalid', 'The target position is not valid.');
      const rest = all.filter((x) => !moving.includes(x));
      const at = m.before === null ? rest.length : rest.indexOf(m.before);
      const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      await tx`UPDATE collection_photos cp SET position = v.pos FROM unnest(${next}::uuid[]) WITH ORDINALITY AS v(pid, pos) WHERE cp.collection_id = ${id}::uuid AND cp.photo_id = v.pid`;
      return ok({ moved: moving.length });
    });
  }
}
