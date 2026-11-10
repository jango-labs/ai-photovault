import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { whereFor, type Filters } from '../library/query.js';
import type { LibraryService, PhotoCard } from '../library/service.js';
import { tsQuerySql, type SearchService } from '../search/service.js';
import { scoreCandidate, select, type Candidate, type Pick, type Purpose, type Reason, type Scored } from './score.js';

/**
 * ADVISORY ONLY. This module reads the library and records suggestions. The only thing it can create besides its own run/feedback
 * records is an AI-draft collection, which stays inactive until a person activates it. It has no import of, and no SQL against,
 * anything that publishes (publishing_drafts, scheduled_publications, Instagram clients) — a test scans this folder to keep it so.
 */
export const POOL_LIMIT = 400;
/** When the first pool collapses into fewer series than requested (many near-identical frames), it is widened once. */
export const WIDE_POOL_LIMIT = 1600;
/** Frames of a series that are stored and shown behind its best frame (the rest are only counted). */
export const HIDDEN_SHOWN = 12;
const POSTED = ['EXACT_MATCH', 'HIGH_CONFIDENCE_MATCH', 'USER_CONFIRMED'];
const Uuid = z.string().uuid();

export const RunSchema = z.object({
  request: z.string().trim().max(300).default(''), count: z.coerce.number().int().min(1).max(60).default(12), purpose: z.enum(['general', 'instagram', 'portfolio']).default('general'),
}).strict();
export const DraftSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), photoIds: z.array(Uuid).min(1).max(60).optional() }).strict();
export const FeedbackSchema = z.object({ photoId: Uuid, verdict: z.enum(['LIKE', 'DISLIKE', 'CLEAR']), runId: Uuid.optional(), note: z.string().trim().max(300).optional() }).strict();

export interface RunResult {
  request: string; purpose: Purpose; count: number;
  understood: Array<{ kind: string; label: string }>; words: string; assumed: string[];
  pool: { matching: number; examined: number }; skipped: { disliked: number; series: number; alreadyInPortfolio: number };
  picks: Pick[]; alternatives: Scored[];
}
export interface RunView extends RunResult { id: string; createdAt: string; cards: Record<string, PhotoCard> }
type Outcome<T> = { ok: true; value: T } | { ok: false; code: 'not_found' | 'invalid' | 'name_in_use'; message: string };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

function parseVec(t: string | null): Float32Array | null {
  if (!t) return null;
  const a = t.slice(1, -1).split(','); const v = new Float32Array(a.length); for (let i = 0; i < a.length; i++) v[i] = Number(a[i]);
  return v;
}
interface PoolRow {
  id: string; rating: number; favorite: boolean; portfolio: boolean; capture_at: Date | null; location: string | null; overall: number | null; sharpness: number | null; exposure: number | null;
  species: string | null; posted_at: Date | null; emb: string | null;
}

export class CuratorService {
  constructor(private readonly sql: Sql, private readonly library: LibraryService, private readonly search: SearchService, private readonly now: () => Date = () => new Date()) {}

  async run(userId: string, p: z.infer<typeof RunSchema>): Promise<RunView> {
    const { parsed, filters: base, text: rawText } = await this.search.resolve(userId, p.request);
    // "…for Instagram" / "…for my portfolio" names the purpose (chosen separately); left in the text it would be required as a word and match nothing
    const text = rawText.replace(/\b(?:(?:for|on|to|in|into)\s+)?(?:my\s+)?(?:instagram|insta|portfolio)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const filters: Filters = { ...base }; const assumed: string[] = [];
    // sensible defaults, always stated: an Instagram selection means "not posted yet"; a portfolio selection means "not in it yet"
    if (p.purpose === 'instagram' && !filters.ig?.length) { filters.ig = ['never']; assumed.push('Instagram selection: only photographs never posted'); }
    if (p.purpose === 'portfolio' && filters.portfolio === undefined) { filters.portfolio = false; assumed.push('Portfolio selection: only photographs not in the portfolio yet'); }

    const load = (limit: number) => withUser(this.sql, userId, async (tx) => {
      const fbRows = await tx<{ photo_id: string; verdict: string }[]>`SELECT DISTINCT ON (photo_id) photo_id, verdict FROM curator_feedback ORDER BY photo_id, at DESC`;
      const disliked = fbRows.filter((r) => r.verdict === 'DISLIKE').map((r) => r.photo_id);
      const tsq = tsQuerySql(tx, text, 'and');
      const match = tsq ? [tx`p.id IN (SELECT sd.photo_id FROM search_documents sd WHERE sd.doc @@ (${tsq}))`] : [];
      const where = whereFor(tx, filters, [...match, tx`p.id <> ALL(${disliked}::uuid[])`]);
      const [rows, cnt] = await Promise.all([
        tx<PoolRow[]>`
          SELECT p.id, p.rating, p.favorite, p.portfolio_candidate AS portfolio, p.capture_at, p.trip_location AS location, an.overall, an.sharpness, an.exposure, sp.name AS species, posted.at AS posted_at, e.embedding::text AS emb
            FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
            LEFT JOIN LATERAL (SELECT a.overall_score::float8 AS overall, (a.scores ->> 'sharpness')::float8 AS sharpness, (a.scores ->> 'exposure')::float8 AS exposure FROM ai_analyses a WHERE a.photo_version_id = v.id ORDER BY a.created_at DESC LIMIT 1) an ON true
            LEFT JOIN LATERAL (SELECT s.common_name AS name FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = p.id AND ps.status <> 'REJECTED' ORDER BY (ps.status = 'CONFIRMED') DESC, ps.confidence DESC NULLS LAST LIMIT 1) sp ON true
            LEFT JOIN LATERAL (SELECT max(sp2.posted_at) AS at FROM photo_social_matches m JOIN social_post_media spm ON spm.id = m.social_post_media_id JOIN social_posts sp2 ON sp2.id = spm.social_post_id WHERE m.photo_id = p.id AND m.state = ANY(${POSTED}::text[])) posted ON true
            LEFT JOIN photo_embeddings e ON e.photo_version_id = v.id AND e.model = 'local-visual-v1' AND e.kind = 'image'
           WHERE ${where}
           ORDER BY p.rating DESC, an.overall DESC NULLS LAST, p.capture_at DESC NULLS LAST, p.id LIMIT ${limit}`,
        tx<{ n: string }[]>`SELECT count(*) AS n FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${where}`,
      ]);
      const ids = rows.map((r) => r.id);
      const pr = ids.length ? await tx<{ photo_a: string; photo_b: string }[]>`SELECT photo_a, photo_b FROM duplicate_pairs WHERE state <> 'DISTINCT' AND photo_a = ANY(${ids}::uuid[]) AND photo_b = ANY(${ids}::uuid[])` : [];
      return { rows, matching: Number(cnt[0]!.n), fb: new Map(fbRows.map((r) => [r.photo_id, r.verdict])), pairs: pr };
    });
    const choose = async (limit: number) => {
      const { rows, matching, fb, pairs } = await load(limit);
      const dups = new Map<string, string[]>(); for (const x of pairs) { (dups.get(x.photo_a) ?? dups.set(x.photo_a, []).get(x.photo_a)!).push(x.photo_b); (dups.get(x.photo_b) ?? dups.set(x.photo_b, []).get(x.photo_b)!).push(x.photo_a); }

      let cands: Candidate[] = rows.map((r) => ({
        id: r.id, rating: r.rating, favorite: r.favorite, portfolio: r.portfolio, captureAt: r.capture_at?.toISOString() ?? null, location: r.location, species: r.species,
        overall: r.overall, sharpness: r.sharpness, exposure: r.exposure, postedAt: r.posted_at?.toISOString() ?? null, liked: fb.get(r.id) === 'LIKE', embedding: parseVec(r.emb), duplicates: dups.get(r.id) ?? [],
      }));
      const disliked = [...fb.values()].filter((v) => v === 'DISLIKE').length;
      const inPortfolio = p.purpose === 'portfolio' ? cands.filter((c) => c.portfolio).length : 0;
      if (p.purpose === 'portfolio') cands = cands.filter((c) => !c.portfolio);
      const now = this.now();
      const sel = select(cands, cands.map((c) => scoreCandidate(c, p.purpose, now)), p.count);
      return { sel, cands, matching, disliked, inPortfolio };
    };
    let { sel, cands, matching, disliked, inPortfolio } = await choose(POOL_LIMIT);
    if (sel.picks.length < p.count && matching > cands.length) ({ sel, cands, matching, disliked, inPortfolio } = await choose(WIDE_POOL_LIMIT));

    const result: RunResult = {
      request: p.request, purpose: p.purpose, count: p.count, understood: parsed.understood, words: text, assumed,
      pool: { matching, examined: cands.length }, skipped: { disliked, series: sel.suppressed.length, alreadyInPortfolio: inPortfolio }, picks: sel.picks.map((k) => ({ ...k, hidden: k.hidden.slice(0, HIDDEN_SHOWN) })), alternatives: sel.alternatives,
    };
    const id = await withUser(this.sql, userId, async (tx) => (await tx<{ id: string }[]>`INSERT INTO curator_runs (user_id, request, purpose, count, result) VALUES (${userId}, ${p.request}, ${p.purpose}, ${p.count}, ${tx.json(result as never)}) RETURNING id`)[0]!.id);
    await withUser(this.sql, userId, (tx) => tx`DELETE FROM curator_runs WHERE id IN (SELECT id FROM curator_runs ORDER BY created_at DESC OFFSET 30)`);
    return this.view(userId, id, result, new Date());
  }

  private async view(userId: string, id: string, r: RunResult, createdAt: Date): Promise<RunView> {
    const ids = [...new Set([...r.picks.flatMap((x) => [x.id, ...x.hidden]), ...r.alternatives.map((a) => a.id)])];
    const cards = await this.library.cards(userId, ids);
    return { ...r, id, createdAt: createdAt.toISOString(), cards: Object.fromEntries(cards.map((c) => [c.id, c])) };
  }

  async getRun(userId: string, id: string): Promise<RunView | null> {
    const [row] = await withUser(this.sql, userId, (tx) => tx<{ result: RunResult; created_at: Date }[]>`SELECT result, created_at FROM curator_runs WHERE id = ${id}::uuid`);
    return row ? this.view(userId, id, row.result, row.created_at) : null;
  }
  async runs(userId: string) {
    const rows = await withUser(this.sql, userId, (tx) => tx<{ id: string; request: string; purpose: string; count: number; created_at: Date; picks: number }[]>`
      SELECT id, request, purpose, count, created_at, jsonb_array_length(result -> 'picks') AS picks FROM curator_runs ORDER BY created_at DESC LIMIT 20`);
    return rows.map((r) => ({ id: r.id, request: r.request, purpose: r.purpose, count: r.count, picks: r.picks, createdAt: r.created_at.toISOString() }));
  }

  /** Turns (a subset of) a run's picks into an AI-DRAFT collection. Nothing is activated or published. */
  async draft(userId: string, runId: string, d: z.infer<typeof DraftSchema>): Promise<Outcome<{ id: string; name: string }>> {
    return withUser(this.sql, userId, async (tx) => {
      const [run] = await tx<{ request: string; purpose: string; result: RunResult; created_at: Date }[]>`SELECT request, purpose, result, created_at FROM curator_runs WHERE id = ${runId}::uuid`;
      if (!run) return { ok: false as const, code: 'not_found' as const, message: 'No such run.' };
      const allowed = new Set([...run.result.picks.map((x) => x.id), ...run.result.alternatives.map((x) => x.id)]);          // the picks, or an alternative a person chose instead
      const chosen = d.photoIds ?? run.result.picks.map((x) => x.id);
      if (!chosen.length || new Set(chosen).size !== chosen.length || chosen.some((x) => !allowed.has(x))) return { ok: false as const, code: 'invalid' as const, message: 'Only photographs the curator suggested or considered in this run can be saved.' };
      const base = d.name ?? `Curator: ${run.request || 'best photographs'}`.slice(0, 70);
      let name = base; for (let n = 2; (await tx`SELECT 1 FROM collections WHERE lower(name) = lower(${name}) AND status <> 'ARCHIVED'`).length; n++) name = `${base.slice(0, 74)} (${n})`;
      const why = `Suggested by the AI Curator for “${run.request || 'your best photographs'}” (${run.purpose}): ${run.result.picks.length} of ${run.result.pool.matching.toLocaleString('en-GB')} matching photographs, chosen by rating, measured quality${run.purpose === 'instagram' ? ', Instagram history' : ''} and variety. Review it, then activate or discard.`;
      const [c] = await tx<{ id: string }[]>`INSERT INTO collections (user_id, name, kind, status, created_by, rationale) VALUES (${userId}, ${name}, 'AI_DRAFT', 'DRAFT', 'AI', ${why}) RETURNING id`;
      await tx`INSERT INTO collection_photos (user_id, collection_id, photo_id, position, added_by, note)
               SELECT ${userId}, ${c!.id}::uuid, v.pid, v.pos - 1, 'AI', NULL FROM unnest(${chosen}::uuid[]) WITH ORDINALITY AS v(pid, pos)`;
      return ok({ id: c!.id, name });
    });
  }

  async feedback(userId: string, f: z.infer<typeof FeedbackSchema>): Promise<Outcome<null>> {
    return withUser(this.sql, userId, async (tx) => {
      const [p] = await tx`SELECT 1 FROM photos WHERE id = ${f.photoId}::uuid AND deleted_at IS NULL`;
      if (!p) return { ok: false as const, code: 'not_found' as const, message: 'No such photograph.' };
      await tx`INSERT INTO curator_feedback (user_id, photo_id, run_id, verdict, note) VALUES (${userId}, ${f.photoId}::uuid, ${f.runId ?? null}::uuid, ${f.verdict}, ${f.note ?? null})`;
      return ok(null);
    });
  }
  async currentFeedback(userId: string): Promise<{ liked: PhotoCard[]; disliked: PhotoCard[] }> {
    const rows = await withUser(this.sql, userId, (tx) => tx<{ photo_id: string; verdict: string }[]>`SELECT photo_id, verdict FROM (SELECT DISTINCT ON (photo_id) photo_id, verdict FROM curator_feedback ORDER BY photo_id, at DESC) l WHERE verdict <> 'CLEAR'`);
    const cards = new Map((await this.library.cards(userId, rows.map((r) => r.photo_id))).map((c) => [c.id, c]));
    const pick = (v: string) => rows.filter((r) => r.verdict === v).map((r) => cards.get(r.photo_id)).filter((c): c is PhotoCard => !!c);
    return { liked: pick('LIKE'), disliked: pick('DISLIKE') };
  }

  /** "What should I look at next?" — groups of strong, never-posted photographs worth a selection, each as a ready-made request. */
  async themes(userId: string): Promise<Array<{ title: string; request: string; count: number }>> {
    return withUser(this.sql, userId, async (tx) => {
      const notPosted = tx`NOT EXISTS (SELECT 1 FROM photo_social_matches m WHERE m.photo_id = p.id AND m.state = ANY(${POSTED}::text[]))`;
      const [bySpecies, byPlace] = await Promise.all([
        tx<{ species: string; place: string; n: number }[]>`SELECT s.common_name AS species, p.trip_location AS place, count(DISTINCT p.id)::int AS n
            FROM photos p JOIN photo_species ps ON ps.photo_id = p.id AND ps.status <> 'REJECTED' JOIN species s ON s.id = ps.species_id
           WHERE p.deleted_at IS NULL AND NOT p.hidden AND p.rating >= 4 AND p.trip_location IS NOT NULL AND ${notPosted} GROUP BY 1, 2 HAVING count(DISTINCT p.id) >= 3 ORDER BY n DESC LIMIT 6`,
        tx<{ place: string; year: number; n: number }[]>`SELECT p.trip_location AS place, p.year, count(*)::int AS n FROM photos p
           WHERE p.deleted_at IS NULL AND NOT p.hidden AND p.rating >= 4 AND p.trip_location IS NOT NULL AND p.year IS NOT NULL AND ${notPosted} GROUP BY 1, 2 HAVING count(*) >= 5 ORDER BY n DESC LIMIT 6`,
      ]);
      return [
        ...bySpecies.map((r) => ({ title: `${r.species} in ${r.place}`, request: `${r.species} in ${r.place} 4+ stars never posted`, count: r.n })),
        ...byPlace.map((r) => ({ title: `${r.place}, ${r.year}`, request: `${r.place} ${r.year} 4+ stars never posted`, count: r.n })),
      ].sort((a, b) => b.count - a.count).slice(0, 8);
    });
  }
}
export type { Reason };
