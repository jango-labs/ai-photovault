import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { FiltersSchema, cameraLabel, whereFor, type Filters } from '../library/query.js';
import type { LibraryService, PhotoCard } from '../library/service.js';
import { LOCAL_EMBEDDING_MODEL } from './embedding.js';
import { parseQuery, type ParsedFilters, type SearchContext, type Understood } from './parse.js';
import { refreshSearch } from './index.js';
import { OLLAMA_EMBED_DIMS, OLLAMA_EMBED_MODEL_ID, OllamaClient, embedQuery } from '../ai/ollama.js';
import { toVectorLiteral } from './embedding.js';

export const MAX_OFFSET = 5000;
export const SearchSchema = z.object({
  q: z.string().trim().max(300).default(''),
  /** `kind:label` of understood phrases the user removed; the filter is dropped, the words are not searched */
  exclude: z.preprocess((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(z.string().max(160)).max(30)).default([]),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
  record: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
}).strict();
export type SearchParams = z.infer<typeof SearchSchema>;

export interface SearchResult {
  items: PhotoCard[]; total: number; nextOffset: number | null; relaxed: boolean;
  parsed: { text: string; understood: Understood[]; filters: ParsedFilters };
  /** Whether this search also used MEANING (embeddings of the local vision model's descriptions). `used` is false for plain word matching; `reason` always says why. */
  semantic: SemanticStatus;
}
export interface SemanticStatus { available: boolean; used: boolean; reason: string; mode?: 'description-embedding'; model?: string; coverage?: { embedded: number; photos: number } }
/** Cosine similarity a description must reach to count as a meaning match (nomic-embed-text, calibrated on the pilot photographs: unrelated queries peaked at 0.53–0.56, real matches scored 0.60–0.84). */
export const MIN_SEMANTIC_SIMILARITY = Number(process.env.PHOTOVAULT_SEMANTIC_MIN ?? 0.58);
export const SEMANTIC_NOTE = 'Searching by meaning (for example "a lone tree in mist") needs a text-and-image embedding model. Only the local picture-to-picture model is installed, so words are matched against titles, places, species, descriptions and measured looks, and "Find similar" compares pictures directly.';

const CTX_TTL_MS = 30_000;
const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).slice(0, 12);
/** to_tsquery text built only from [a-z0-9] tokens, so user input can never inject query operators. */
export const tsQueryText = (text: string, mode: 'and' | 'or'): string => words(text).map((w) => `${w}:*`).join(mode === 'and' ? ' & ' : ' | ');

/** A tsquery that matches each word under EITHER text-search configuration: 'english' (titles and descriptions, stemmed) or 'simple' (camera, lens, place names, keywords: never stemmed). */
export function tsQuerySql(tx: Sql, text: string, mode: 'and' | 'or') {
  const terms = words(text).map((w) => tx`(to_tsquery('english', ${`${w}:*`}) || to_tsquery('simple', ${`${w}:*`}))`);
  return terms.length ? terms.reduce((a, b) => (mode === 'and' ? tx`${a} && ${b}` : tx`${a} || ${b}`)) : null;
}

function toFilters(p: ParsedFilters): Filters {
  const f = FiltersSchema.parse({});
  const set = <K extends keyof Filters>(k: K, v: Filters[K] | undefined) => { if (v !== undefined && !(Array.isArray(v) && v.length === 0)) f[k] = v; };
  set('year', p.year); set('month', p.month); set('rating', p.rating); set('favorite', p.favorite); set('portfolio', p.portfolio); set('ig', p.ig);
  set('orientation', p.orientation); set('place', p.location); set('species', p.species); set('camera', p.camera); set('lens', p.lens); set('colour', p.colour); set('tag', p.tag);
  return f;
}

function applyExclusions(parsed: ReturnType<typeof parseQuery>, exclude: string[]) {
  if (!exclude.length) return parsed;
  const drop = new Set(exclude); const f = { ...parsed.filters };
  for (const u of parsed.understood) {
    if (!drop.has(`${u.kind}:${u.label}`)) continue;
    switch (u.kind) {
      case 'year': f.year = []; break; case 'month': f.month = []; break; case 'rating': f.rating = []; break; case 'favorite': delete f.favorite; break; case 'portfolio': delete f.portfolio; break;
      case 'instagram': f.ig = []; break; case 'orientation': f.orientation = []; break; case 'camera': f.camera = f.camera.filter((x) => x !== u.label); break; case 'lens': f.lens = f.lens.filter((x) => x !== u.label); break;
      case 'location': f.location = f.location.filter((x) => x !== u.label); break; case 'species': f.species = f.species.filter((x) => x !== u.label); break;
      case 'colour': f.colour = f.colour.filter((x) => x !== u.label); break; case 'tone': f.tag = []; break;
    }
  }
  return { ...parsed, filters: f, understood: parsed.understood.filter((u) => !drop.has(`${u.kind}:${u.label}`)) };
}

export interface SimilarResult { items: Array<PhotoCard & { similarity: number }>; model: string }

export class SearchService {
  private readonly ctxCache = new Map<string, { at: number; ctx: SearchContext }>();
  constructor(private readonly sql: Sql, private readonly library: LibraryService, private readonly ollama: OllamaClient | null = null) {}

  /** What exists in this library: the vocabulary the parser may map words onto. */
  private async context(userId: string): Promise<SearchContext> {
    const hit = this.ctxCache.get(userId);
    if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.ctx;
    const ctx = await withUser(this.sql, userId, async (tx) => {
      const [locations, species, cameras, lenses] = await Promise.all([
        tx<{ v: string }[]>`SELECT DISTINCT trip_location AS v FROM photos WHERE deleted_at IS NULL AND trip_location IS NOT NULL LIMIT 500`,
        tx<{ name: string; scientific: string | null }[]>`SELECT s.common_name AS name, s.scientific_name AS scientific FROM species s WHERE EXISTS (SELECT 1 FROM photo_species ps WHERE ps.species_id = s.id AND ps.status <> 'REJECTED') LIMIT 500`,
        tx<{ v: string }[]>`SELECT DISTINCT ${cameraLabel(tx)} AS v FROM photo_versions v WHERE v.camera_model IS NOT NULL LIMIT 200`,
        tx<{ v: string }[]>`SELECT DISTINCT lens AS v FROM photo_versions WHERE lens IS NOT NULL LIMIT 200`,
      ]);
      return { locations: locations.map((r) => r.v), species, cameras: cameras.map((r) => r.v), lenses: lenses.map((r) => r.v) } satisfies SearchContext;
    });
    this.ctxCache.set(userId, { at: Date.now(), ctx });
    return ctx;
  }
  /** Parsed request, library-style filters and the leftover words — for other advisory features that rank their own way (the AI Curator). */
  async resolve(userId: string, q: string, exclude: string[] = []) {
    const parsed = applyExclusions(parseQuery(q, await this.context(userId)), exclude);
    return { parsed, filters: toFilters(parsed.filters), text: parsed.text };
  }
  forgetContext(userId: string): void { this.ctxCache.delete(userId); }

  async search(userId: string, params: SearchParams): Promise<SearchResult> {
    const ctx = await this.context(userId);
    const parsed = applyExclusions(parseQuery(params.q, ctx), params.exclude);
    const filters = toFilters(parsed.filters);
    const run = (mode: 'and' | 'or') => this.runQuery(userId, filters, parsed.text, mode, params.limit, params.offset);
    let r = await run('and'); let relaxed = false;
    if (r.total === 0 && parsed.text && words(parsed.text).length > 1) { r = await run('or'); relaxed = r.total > 0; }
    let semantic: SemanticStatus = { available: false, used: false, reason: SEMANTIC_NOTE };
    if (parsed.text) {
      const sem = await this.semanticFor(userId, parsed.text); semantic = sem.status;
      if (sem.vec) {
        const fused = await this.hybrid(userId, filters, parsed.text, sem.vec, relaxed);
        r = { ids: fused.slice(params.offset, params.offset + params.limit), more: params.offset + params.limit < fused.length, total: fused.length }; relaxed = false; semantic = { ...semantic, used: true };
      }
    }
    const items = await this.library.cards(userId, r.ids);
    const result: SearchResult = {
      items, total: r.total, nextOffset: r.more && params.offset + params.limit <= MAX_OFFSET ? params.offset + params.limit : null, relaxed,
      parsed: { text: parsed.text, understood: parsed.understood, filters: parsed.filters }, semantic,
    };
    if (params.record && params.offset === 0 && params.q) await this.remember(userId, params.q, result);
    return result;
  }

  /** Can this query also be matched by meaning? Needs the local embedding model reachable and at least one photograph with a description embedding. */
  private async semanticFor(userId: string, text: string): Promise<{ status: SemanticStatus; vec: Float32Array | null }> {
    const model = this.ollama ? OLLAMA_EMBED_MODEL_ID(this.ollama.cfg.embedModel) : null;
    if (!this.ollama || !model) return { status: { available: false, used: false, reason: SEMANTIC_NOTE }, vec: null };
    const [c] = await withUser(this.sql, userId, (tx) => tx<{ photos: number; embedded: number }[]>`
      SELECT count(*)::int AS photos, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM photo_embeddings e WHERE e.photo_version_id = p.current_version_id AND e.model = ${model} AND e.kind = 'text'))::int AS embedded
        FROM photos p WHERE p.deleted_at IS NULL AND NOT p.hidden`);
    const coverage = { embedded: c?.embedded ?? 0, photos: c?.photos ?? 0 };
    const base = { mode: 'description-embedding' as const, model, coverage };
    if (coverage.embedded === 0) return { status: { available: false, used: false, ...base, reason: 'Meaning-based search needs photographs analysed by the local vision model (Settings → AI → “Local vision model via Ollama”). None has been yet, so words are matched against titles, places, equipment, keywords and descriptions.' }, vec: null };
    try {
      const vec = await embedQuery(this.ollama, text);
      if (vec.length !== OLLAMA_EMBED_DIMS) throw new Error('unexpected embedding size');
      return { status: { available: true, used: false, ...base, reason: `Words are matched exactly AND by meaning against the descriptions written by the local vision model, which covers ${coverage.embedded} of ${coverage.photos} photographs; the rest are matched by words only.` }, vec };
    } catch (e) {
      return { status: { available: false, used: false, ...base, reason: `Meaning-based search is unavailable right now (${e instanceof Error ? e.message : 'the embedding model did not answer'}); words were matched instead.` }, vec: null };
    }
  }

  /** Reciprocal-rank fusion of the word matches and the meaning matches (within the same filters). */
  private async hybrid(userId: string, filters: Filters, text: string, vec: Float32Array, relaxed: boolean): Promise<string[]> {
    const model = OLLAMA_EMBED_MODEL_ID(this.ollama!.cfg.embedModel); const lit = toVectorLiteral(vec);
    const words100 = await this.runQuery(userId, filters, text, relaxed ? 'or' : 'and', 100, 0);
    const meaning = await withUser(this.sql, userId, async (tx) => {
      const where = whereFor(tx, filters);
      return tx<{ id: string; sim: number }[]>`
        SELECT p.id, (1 - (e.embedding::halfvec(768) <=> ${lit}::halfvec(768)))::float8 AS sim
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id JOIN photo_embeddings e ON e.photo_version_id = v.id AND e.model = ${model} AND e.kind = 'text'
         WHERE ${where} ORDER BY e.embedding::halfvec(768) <=> ${lit}::halfvec(768) LIMIT 100`;
    });
    const score = new Map<string, number>(); const add = (id: string, rank: number) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + rank));
    words100.ids.forEach((id, i) => add(id, i)); meaning.filter((m) => m.sim >= MIN_SEMANTIC_SIMILARITY).forEach((m, i) => add(m.id, i));
    return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  private async runQuery(userId: string, filters: Filters, text: string, mode: 'and' | 'or', limit: number, offset: number) {
    return withUser(this.sql, userId, async (tx) => {
      const tsq = tsQuerySql(tx, text, mode);
      const match = tsq ? [tx`p.id IN (SELECT sd.photo_id FROM search_documents sd WHERE sd.doc @@ (${tsq}))`] : [];
      const where = whereFor(tx, filters, match);
      const order = tsq
        ? tx`ORDER BY (SELECT ts_rank_cd(sd.doc, (${tsq})) FROM search_documents sd WHERE sd.photo_id = p.id) DESC NULLS LAST, p.capture_at DESC NULLS LAST, p.id DESC`
        : tx`ORDER BY p.capture_at DESC NULLS LAST, p.id DESC`;
      const [rows, count] = await Promise.all([
        tx<{ id: string }[]>`SELECT p.id FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where} ${order} OFFSET ${offset} LIMIT ${limit + 1}`,
        offset === 0 ? tx<{ n: string }[]>`SELECT count(*) AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where}` : Promise.resolve(null),
      ]);
      const more = rows.length > limit;
      return { ids: rows.slice(0, limit).map((r) => r.id), more, total: count ? Number(count[0]!.n) : offset + Math.min(rows.length, limit) };
    });
  }

  /** Photographs that look like this one (local visual embedding, cosine distance, HNSW index). */
  async similar(userId: string, photoId: string, limit = 24): Promise<SimilarResult | { missing: 'photo' | 'embedding' }> {
    const rows = await withUser(this.sql, userId, async (tx) => {
      const [src] = await tx<{ version_id: string }[]>`SELECT current_version_id AS version_id FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL`;
      if (!src) return 'photo' as const;
      const [has] = await tx`SELECT 1 FROM photo_embeddings WHERE photo_version_id = ${src.version_id}::uuid AND model = ${LOCAL_EMBEDDING_MODEL} AND kind = 'image'`;
      if (!has) return 'embedding' as const;
      await tx`SET LOCAL hnsw.ef_search = 200`;
      return tx<{ photo_id: string; sim: number }[]>`
        WITH q AS (SELECT embedding::halfvec(256) AS e FROM photo_embeddings WHERE photo_version_id = ${src.version_id}::uuid AND model = 'local-visual-v1' AND kind = 'image'),
        near AS (
          SELECT pe.photo_version_id, (pe.embedding::halfvec(256) <=> (SELECT e FROM q)) AS dist
            FROM photo_embeddings pe WHERE pe.model = 'local-visual-v1' AND pe.kind = 'image'
           ORDER BY pe.embedding::halfvec(256) <=> (SELECT e FROM q) LIMIT ${limit * 6})
        SELECT p.id AS photo_id, (1 - n.dist)::float8 AS sim
          FROM near n JOIN photos p ON p.current_version_id = n.photo_version_id
         WHERE p.id <> ${photoId}::uuid AND p.deleted_at IS NULL AND NOT p.hidden
         ORDER BY n.dist, p.id LIMIT ${limit}`;
    });
    if (rows === 'photo' || rows === 'embedding') return { missing: rows };
    const cards = await this.library.cards(userId, rows.map((r) => r.photo_id));
    const sim = new Map(rows.map((r) => [r.photo_id, r.sim]));
    return { model: LOCAL_EMBEDDING_MODEL, items: cards.map((c) => ({ ...c, similarity: Math.round((sim.get(c.id) ?? 0) * 1000) / 1000 })) };
  }

  // ---- history
  private async remember(userId: string, q: string, r: SearchResult): Promise<void> {
    await withUser(this.sql, userId, async (tx) => {
      await tx`DELETE FROM search_history WHERE lower(q) = lower(${q})`;
      await tx`INSERT INTO search_history (user_id, q, parsed, result_count) VALUES (${userId}, ${q}, ${tx.json(r.parsed.understood as never)}, ${r.total})`;
      await tx`DELETE FROM search_history WHERE id IN (SELECT id FROM search_history ORDER BY at DESC OFFSET 50)`;
    });
  }
  async history(userId: string) {
    return withUser(this.sql, userId, (tx) => tx<{ id: string; q: string; result_count: number | null; at: Date }[]>`SELECT id, q, result_count, at FROM search_history ORDER BY at DESC LIMIT 20`)
      .then((rows) => rows.map((r) => ({ id: r.id, q: r.q, resultCount: r.result_count, at: r.at.toISOString() })));
  }
  async clearHistory(userId: string, id?: string): Promise<number> {
    return withUser(this.sql, userId, async (tx) => (id ? await tx`DELETE FROM search_history WHERE id = ${id}::uuid RETURNING id` : await tx`DELETE FROM search_history RETURNING id`).length);
  }

  // ---- saved searches (collections of kind SAVED_SEARCH; the query is stored, never a frozen result)
  async saved(userId: string) {
    return withUser(this.sql, userId, (tx) => tx<{ id: string; name: string; query: { q?: string; exclude?: string[] }; created_at: Date }[]>`
      SELECT id, name, query, created_at FROM collections WHERE kind = 'SAVED_SEARCH' AND status <> 'ARCHIVED' ORDER BY lower(name)`)
      .then((rows) => rows.map((r) => ({ id: r.id, name: r.name, q: r.query.q ?? '', exclude: r.query.exclude ?? [], createdAt: r.created_at.toISOString() })));
  }
  async save(userId: string, name: string, q: string, exclude: string[]): Promise<{ id: string } | { duplicate: true }> {
    return withUser(this.sql, userId, async (tx) => {
      const [dup] = await tx`SELECT 1 FROM collections WHERE lower(name) = lower(${name}) AND status <> 'ARCHIVED'`;
      if (dup) return { duplicate: true as const };
      const [r] = await tx<{ id: string }[]>`INSERT INTO collections (user_id, name, kind, query) VALUES (${userId}, ${name}, 'SAVED_SEARCH', ${tx.json({ q, exclude } as never)}) RETURNING id`;
      return { id: r!.id };
    });
  }
  async deleteSaved(userId: string, id: string): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => (await tx`DELETE FROM collections WHERE id = ${id}::uuid AND kind = 'SAVED_SEARCH' RETURNING id`).length === 1);
  }

  // ---- discovery
  async discover(userId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [species, places, years, tags] = await Promise.all([
        tx<{ name: string; n: number }[]>`SELECT s.common_name AS name, count(DISTINCT ps.photo_id)::int AS n FROM photo_species ps JOIN species s ON s.id = ps.species_id JOIN photos p ON p.id = ps.photo_id WHERE ps.status <> 'REJECTED' AND p.deleted_at IS NULL AND NOT p.hidden GROUP BY 1 ORDER BY n DESC, 1 LIMIT 16`,
        tx<{ name: string; n: number }[]>`SELECT trip_location AS name, count(*)::int AS n FROM photos WHERE deleted_at IS NULL AND NOT hidden AND trip_location IS NOT NULL GROUP BY 1 ORDER BY n DESC, 1 LIMIT 16`,
        tx<{ year: number; n: number }[]>`SELECT capture_year AS year, count(*)::int AS n FROM photos WHERE deleted_at IS NULL AND NOT hidden AND capture_year IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
        tx<{ name: string; n: number }[]>`SELECT t AS name, count(*)::int AS n FROM ai_analyses a, unnest(a.tags) t GROUP BY 1 ORDER BY n DESC, 1 LIMIT 12`,
      ]);
      const examples: string[] = [];
      if (species[0] && places[0]) examples.push(`${species[0].name.toLowerCase()} in ${places[0].name} never posted`);
      if (species[1]) examples.push(`my best ${species[1].name.toLowerCase()} photos`);
      if (years[0]) examples.push(`5 star portrait photos from ${years[0].year}`);
      if (tags[0]) examples.push(`${tags[0].name} favourites`);
      return { species, places, years, tags, examples };
    });
  }

  // ---- maintenance
  async status(userId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [r] = await tx<{ photos: number; docs: number; emb: number; queued: number }[]>`SELECT
        (SELECT count(*)::int FROM photos WHERE deleted_at IS NULL) AS photos, (SELECT count(*)::int FROM search_documents) AS docs,
        (SELECT count(*)::int FROM photo_embeddings WHERE model = ${LOCAL_EMBEDDING_MODEL} AND kind = 'image') AS emb,
        (SELECT count(*)::int FROM jobs WHERE kind = 'embed.image' AND state IN ('QUEUED','RUNNING')) AS queued`;
      return { photos: r!.photos, indexed: r!.docs, embedded: r!.emb, embeddingsQueued: r!.queued, embeddingModel: LOCAL_EMBEDDING_MODEL };
    });
  }
  /** Rebuild every searchable document and queue embeddings for previews that do not have one. */
  async reindex(userId: string) {
    this.forgetContext(userId);
    return withUser(this.sql, userId, async (tx) => {
      const indexed = await refreshSearch(tx, userId);
      const q = await tx`INSERT INTO jobs (user_id, kind, payload, dedupe_key)
        SELECT ${userId}, 'embed.image', jsonb_build_object('versionId', v.id), 'embed:' || v.id::text || ':' || ${LOCAL_EMBEDDING_MODEL}
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
         WHERE p.deleted_at IS NULL AND v.deriv_status = 'READY'
           AND NOT EXISTS (SELECT 1 FROM photo_embeddings e WHERE e.photo_version_id = v.id AND e.model = ${LOCAL_EMBEDDING_MODEL} AND e.kind = 'image')
        ON CONFLICT DO NOTHING RETURNING id`;
      return { indexed, embeddingsQueued: q.length };
    });
  }
}
