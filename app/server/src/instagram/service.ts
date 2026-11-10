import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import type { LibraryService, PhotoCard } from '../library/service.js';
import { writeSyntheticArchive, type ArchiveSummary, type LibrarySource } from './synthetic.js';

const Uuid = z.string().uuid();
export const HistorySchema = z.object({ filter: z.enum(['all', 'matched', 'review', 'unmatched']).default('all'), limit: z.coerce.number().int().min(1).max(200).default(60), cursor: z.string().max(300).optional() }).strict();
export const ReviewSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const DecideSchema = z.object({ decision: z.enum(['confirm', 'reject']) }).strict();
export const LinkSchema = z.object({ photoId: Uuid }).strict();
export const SyntheticSchema = z.object({ count: z.coerce.number().int().min(1).max(300).default(40) }).strict();
export const PostedCheckSchema = z.object({ photoId: Uuid }).strict();
const POSTED = ['EXACT_MATCH', 'HIGH_CONFIDENCE_MATCH', 'USER_CONFIRMED'];

type Fail = { ok: false; code: 'not_found' | 'unavailable' | 'invalid' | 'conflict'; message: string };
const fail = (code: Fail['code'], message: string): Fail => ({ ok: false, code, message });
const ok = <T>(value: T) => ({ ok: true as const, value });
const cursorOf = (r: { t: string; id: string }) => Buffer.from(JSON.stringify(r)).toString('base64url');
const readCursor = (s: string): { t: string; id: string } | null => { try { const v = z.object({ t: z.string().max(40), id: Uuid }).safeParse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))); return v.success ? v.data : null; } catch { return null; } };


export interface PostedCheck { kind: 'same' | 'similar' | 'none'; last: { postId: string; mediaId: string; postedAt: string; caption: string | null; permalink: string | null } | null; count: number }
/** Runs inside a user transaction (row-level security applies). null = no such photograph. */
export async function postedCheckIn(tx: Sql, photoId: string): Promise<PostedCheck | null> {
  const [ph] = await tx<{ phash: string | null; vid: string }[]>`SELECT v.phash::text AS phash, v.id AS vid FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.id = ${photoId}::uuid AND p.deleted_at IS NULL`;
  if (!ph) return null;
  type R = { post_id: string; media_id: string; posted_at: Date; caption: string | null; permalink: string | null };
  const same = await tx<R[]>`
    SELECT sp.id AS post_id, x.id AS media_id, sp.posted_at, sp.caption, sp.permalink FROM photo_social_matches m JOIN social_post_media x ON x.id = m.social_post_media_id JOIN social_posts sp ON sp.id = x.social_post_id
     WHERE m.photo_id = ${photoId}::uuid AND m.state = ANY(${POSTED}::text[]) ORDER BY sp.posted_at DESC`;
  const row = (r: R) => ({ postId: r.post_id, mediaId: r.media_id, postedAt: r.posted_at.toISOString(), caption: r.caption, permalink: r.permalink });
  if (same[0]) return { kind: 'same', last: row(same[0]), count: same.length };
  if (ph.phash) {
    const masks = [0, ...Array.from({ length: 16 }, (_, i) => 1 << i)]; const v = BigInt(ph.phash);
    const seg = (shift: number) => masks.map((k) => Number((v >> BigInt(shift)) & 0xffffn) ^ k);
    const sim = await tx<R[]>`
      SELECT sp.id AS post_id, x.id AS media_id, sp.posted_at, sp.caption, sp.permalink FROM social_post_media x JOIN social_posts sp ON sp.id = x.social_post_id
       WHERE x.phash IS NOT NULL AND (x.phash_s0 = ANY(${seg(48)}::int[]) OR x.phash_s1 = ANY(${seg(32)}::int[]) OR x.phash_s2 = ANY(${seg(16)}::int[]) OR x.phash_s3 = ANY(${seg(0)}::int[]))
         AND hamming64(x.phash, ${ph.phash}::bigint) <= 8
         AND NOT EXISTS (SELECT 1 FROM photo_social_matches r WHERE r.social_post_media_id = x.id AND r.photo_id = ${photoId}::uuid AND r.state = 'USER_REJECTED')
       ORDER BY sp.posted_at DESC`;
    if (sim[0]) return { kind: 'similar', last: row(sim[0]), count: sim.length };
  }
  return { kind: 'none', last: null, count: 0 };
}

export interface InstagramDeps { sql: Sql; library: LibraryService; mediaDir: string | null; webDir: string | null; derivativesDir: string | null; syntheticAllowed: boolean }
export interface HistoryItem {
  id: string; postedAt: string; caption: string | null; hashtags: string[]; permalink: string | null; synthetic: boolean; mediaId: string | null; mediaCount: number;
  match: { id: string; state: string; score: number | null; photoId: string; photoTitle: string } | null;
}

export class InstagramService {
  constructor(private readonly d: InstagramDeps) {}
  private get sql() { return this.d.sql; }

  async account(userId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [a] = await tx<{ id: string; username: string | null; account_type: string | null; external_id: string; status: string; last_sync_at: Date | null; last_error: string | null }[]>`
        SELECT id, username, account_type, external_id, status, last_sync_at, last_error FROM social_accounts WHERE platform = 'instagram' ORDER BY created_at LIMIT 1`;      // token columns are not selectable by this role, and never named
      const [stats] = await tx<{ posts: number; matched: number; review: number; unmatched: number }[]>`
        WITH best AS (SELECT sp.id, bool_or(m.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED')) AS matched, bool_or(m.state = 'POSSIBLE_MATCH') AS review
                        FROM social_posts sp LEFT JOIN social_post_media x ON x.social_post_id = sp.id LEFT JOIN photo_social_matches m ON m.social_post_media_id = x.id GROUP BY sp.id)
        SELECT count(*)::int AS posts, count(*) FILTER (WHERE matched)::int AS matched, count(*) FILTER (WHERE NOT coalesce(matched, false) AND review)::int AS review,
               count(*) FILTER (WHERE NOT coalesce(matched, false) AND NOT coalesce(review, false))::int AS unmatched FROM best`;
      const [run] = await tx<{ started_at: Date; finished_at: Date | null; status: string; posts_seen: number; posts_new: number; media_failed: number; matched: number; error: string | null }[]>`SELECT started_at, finished_at, status, posts_seen, posts_new, media_failed, matched, error FROM ig_sync_runs ORDER BY started_at DESC LIMIT 1`;
      const [q] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind = 'ig.sync' AND state IN ('QUEUED','RUNNING')`;
      return {
        account: a ? { id: a.id, username: a.username, type: a.account_type, status: a.status, synthetic: a.external_id.startsWith('synthetic-'), lastSyncAt: a.last_sync_at?.toISOString() ?? null, lastError: a.last_error } : null,
        stats: stats ?? { posts: 0, matched: 0, review: 0, unmatched: 0 }, syncing: (q?.n ?? 0) > 0,
        lastRun: run ? { startedAt: run.started_at.toISOString(), finishedAt: run.finished_at?.toISOString() ?? null, status: run.status, postsSeen: run.posts_seen, postsNew: run.posts_new, mediaFailed: run.media_failed, matched: run.matched, error: run.error } : null,
        capabilities: { synthetic: this.d.syntheticAllowed && !!this.d.mediaDir, live: false },
      };
    });
  }

  /** Builds the synthetic archive from this user's library pictures and queues the sync. Development databases only. */
  async createSynthetic(userId: string, count: number): Promise<ReturnType<typeof ok<{ archive: ArchiveSummary; queued: boolean }>> | Fail> {
    if (!this.d.syntheticAllowed || !this.d.mediaDir) return fail('unavailable', 'A synthetic archive is only available on development databases.');
    const rows = await withUser(this.sql, userId, (tx) => tx<Array<{ photo_id: string; version_id: string; title: string | null; place: string | null; capture_at: Date | null; fixture: string | null }>>`
      SELECT p.id AS photo_id, v.id AS version_id, p.title, p.trip_location AS place, p.capture_at, v.exif -> 'synthetic' ->> 'fixture' AS fixture
        FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE p.deleted_at IS NULL AND NOT p.hidden ORDER BY md5(p.id::text) LIMIT ${count * 3}`);
    const sources: LibrarySource[] = [];
    for (const r of rows) {
      let file: string | null = null;
      if (r.fixture && /^p\d{2}$/.test(r.fixture) && this.d.webDir) file = path.join(this.d.webDir, 'fixtures', `${r.fixture}.jpg`);
      else if (!r.fixture && this.d.derivativesDir) file = path.join(this.d.derivativesDir, r.version_id, 'view.jpg');
      if (file && fs.existsSync(file)) sources.push({ photoId: r.photo_id, title: r.title, place: r.place, captureAt: r.capture_at, file });
      if (sources.length >= count) break;
    }
    if (sources.length === 0) return fail('invalid', 'No library photograph has a preview to build the archive from yet.');
    const dir = path.join(this.d.mediaDir, 'synthetic', userId);
    const archive = await writeSyntheticArchive(dir, sources);
    await withUser(this.sql, userId, async (tx) => {
      await tx`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, status) VALUES (${userId}, 'instagram', ${`synthetic-${userId.slice(0, 8)}`}, 'synthetic_archive', 'SYNTHETIC', 'DISCONNECTED')
               ON CONFLICT (user_id, platform, external_id) DO NOTHING`;
    });
    return ok({ archive, queued: await this.enqueueSync(userId) });
  }

  async enqueueSync(userId: string): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => {
      const [a] = await tx<{ id: string }[]>`SELECT id FROM social_accounts WHERE platform = 'instagram' ORDER BY created_at LIMIT 1`;
      if (!a) return false;
      await tx`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${userId}, 'ig.sync', ${tx.json({ accountId: a.id } as never)}, ${`ig-sync:${a.id}`}) ON CONFLICT DO NOTHING`;
      return true;
    });
  }
  async rematch(userId: string): Promise<void> {
    await withUser(this.sql, userId, (tx) => tx`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${userId}, 'ig.match', ${tx.json({ all: true } as never)}, ${'ig-match'}) ON CONFLICT DO NOTHING`);
  }

  async history(userId: string, p: z.infer<typeof HistorySchema>): Promise<{ items: HistoryItem[]; nextCursor: string | null; counts: { all: number; matched: number; review: number; unmatched: number } } | Fail> {
    const cur = p.cursor ? readCursor(p.cursor) : null; if (p.cursor && !cur) return fail('invalid', 'The page position is no longer valid.');
    return withUser(this.sql, userId, async (tx) => {
      const filter = p.filter === 'matched' ? tx`AND bm.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED')` : p.filter === 'review' ? tx`AND bm.state = 'POSSIBLE_MATCH'` : p.filter === 'unmatched' ? tx`AND bm.id IS NULL` : tx``;
      const after = cur ? tx`AND (sp.posted_at, sp.id) < (${cur.t}::text::timestamptz, ${cur.id}::uuid)` : tx``;
      const rows = await tx<Array<{ id: string; posted_at: string; at_text: string; caption: string | null; hashtags: string[]; permalink: string | null; raw: { synthetic?: boolean } | null; media_id: string | null; media_count: number; match_id: string | null; state: string | null; score: number | null; photo_id: string | null; photo_title: string | null }>>`
        SELECT sp.id, sp.posted_at::text AS at_text, sp.posted_at::text AS posted_at, sp.caption, sp.hashtags, sp.permalink, sp.raw, fm.id AS media_id,
               (SELECT count(*)::int FROM social_post_media WHERE social_post_id = sp.id) AS media_count, bm.id AS match_id, bm.state, bm.score::float8 AS score, bm.photo_id,
               coalesce(ph.title, regexp_replace(v.source_relpath, '^.*/', '')) AS photo_title
          FROM social_posts sp
          LEFT JOIN LATERAL (SELECT id FROM social_post_media WHERE social_post_id = sp.id ORDER BY position LIMIT 1) fm ON true
          LEFT JOIN LATERAL (SELECT m.id, m.state, m.score, m.photo_id FROM photo_social_matches m JOIN social_post_media x ON x.id = m.social_post_media_id
                              WHERE x.social_post_id = sp.id AND m.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED','POSSIBLE_MATCH')
                              ORDER BY (m.state = 'USER_CONFIRMED') DESC, (m.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH')) DESC, m.score DESC NULLS LAST, m.id LIMIT 1) bm ON true
          LEFT JOIN photos ph ON ph.id = bm.photo_id LEFT JOIN photo_versions v ON v.id = ph.current_version_id
         WHERE true ${filter} ${after}
         ORDER BY sp.posted_at DESC, sp.id DESC LIMIT ${p.limit + 1}`;
      const page = rows.slice(0, p.limit); const last = page[page.length - 1];
      const [c] = await tx<{ n: number; m: number; r: number }[]>`
        WITH best AS (SELECT sp.id, bool_or(m.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED')) AS matched, bool_or(m.state = 'POSSIBLE_MATCH') AS review
                        FROM social_posts sp LEFT JOIN social_post_media x ON x.social_post_id = sp.id LEFT JOIN photo_social_matches m ON m.social_post_media_id = x.id GROUP BY sp.id)
        SELECT count(*)::int AS n, count(*) FILTER (WHERE matched)::int AS m, count(*) FILTER (WHERE NOT coalesce(matched, false) AND review)::int AS r FROM best`;
      return {
        items: page.map((r): HistoryItem => ({
          id: r.id, postedAt: new Date(r.posted_at).toISOString(), caption: r.caption, hashtags: r.hashtags, permalink: r.permalink, synthetic: r.raw?.synthetic === true, mediaId: r.media_id, mediaCount: r.media_count,
          match: r.match_id ? { id: r.match_id, state: r.state!, score: r.score, photoId: r.photo_id!, photoTitle: r.photo_title ?? 'Photograph' } : null,
        })),
        nextCursor: rows.length > p.limit && last ? cursorOf({ t: last.at_text, id: last.id }) : null,
        counts: { all: c!.n, matched: c!.m, review: c!.r, unmatched: c!.n - c!.m - c!.r },
      };
    });
  }

  /** The best candidate for each Instagram image that still needs a person's decision, most promising first. */
  async review(userId: string, limit: number) {
    const rows = await withUser(this.sql, userId, (tx) => tx<Array<{ id: string; score: number; signals: Record<string, unknown>; phash_distance: number | null; embedding_similarity: number | null; media_id: string; post_id: string; posted_at: Date; caption: string | null; permalink: string | null; photo_id: string; alternatives: number }>>`
      SELECT m.id, m.score::float8 AS score, m.signals, m.phash_distance, m.embedding_similarity::float8 AS embedding_similarity, x.id AS media_id, sp.id AS post_id, sp.posted_at, sp.caption, sp.permalink, m.photo_id,
             (SELECT count(*)::int FROM photo_social_matches o WHERE o.social_post_media_id = m.social_post_media_id AND o.id <> m.id AND o.state = 'POSSIBLE_MATCH') AS alternatives
        FROM photo_social_matches m JOIN social_post_media x ON x.id = m.social_post_media_id JOIN social_posts sp ON sp.id = x.social_post_id
       WHERE m.state = 'POSSIBLE_MATCH' AND NOT EXISTS (SELECT 1 FROM photo_social_matches s WHERE s.social_post_media_id = m.social_post_media_id AND s.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED'))
         AND NOT EXISTS (SELECT 1 FROM photo_social_matches o WHERE o.social_post_media_id = m.social_post_media_id AND o.state = 'POSSIBLE_MATCH' AND (o.score, o.id) > (m.score, m.id))
       ORDER BY m.score DESC, m.id LIMIT ${limit}`);
    const total = await withUser(this.sql, userId, async (tx) => (await tx<{ n: number }[]>`SELECT count(DISTINCT m.social_post_media_id)::int AS n FROM photo_social_matches m WHERE m.state = 'POSSIBLE_MATCH' AND NOT EXISTS (SELECT 1 FROM photo_social_matches s WHERE s.social_post_media_id = m.social_post_media_id AND s.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED'))`)[0]!.n);
    const cards = new Map((await this.d.library.cards(userId, [...new Set(rows.map((r) => r.photo_id))])).map((c) => [c.id, c]));
    return {
      total,
      items: rows.flatMap((r) => { const photo: PhotoCard | undefined = cards.get(r.photo_id); return photo ? [{ matchId: r.id, score: r.score, signals: r.signals, phashDistance: r.phash_distance, embeddingSimilarity: r.embedding_similarity, alternatives: r.alternatives,
        post: { id: r.post_id, mediaId: r.media_id, postedAt: r.posted_at.toISOString(), caption: r.caption, permalink: r.permalink }, photo }] : []; }),
    };
  }

  async decide(userId: string, matchId: string, decision: 'confirm' | 'reject'): Promise<ReturnType<typeof ok<null>> | Fail> {
    return withUser(this.sql, userId, async (tx) => {
      const [m] = await tx<{ social_post_media_id: string }[]>`
        UPDATE photo_social_matches SET state = ${decision === 'confirm' ? 'USER_CONFIRMED' : 'USER_REJECTED'}, decided_by = 'USER', decided_at = now() WHERE id = ${matchId}::uuid RETURNING social_post_media_id`;
      if (!m) return fail('not_found', 'No such match.');
      // confirming one photograph settles the image: the system's other proposals for it are withdrawn (they stay on record, as NO_MATCH)
      if (decision === 'confirm') await tx`UPDATE photo_social_matches SET state = 'NO_MATCH' WHERE social_post_media_id = ${m.social_post_media_id}::uuid AND id <> ${matchId}::uuid AND decided_by = 'SYSTEM' AND state IN ('POSSIBLE_MATCH','HIGH_CONFIDENCE_MATCH','EXACT_MATCH')`;
      return ok(null);
    });
  }

  /** "This post is that photograph" — chosen by a person, for posts the system could not match. */
  async link(userId: string, mediaId: string, photoId: string): Promise<ReturnType<typeof ok<null>> | Fail> {
    return withUser(this.sql, userId, async (tx) => {
      const [x] = await tx`SELECT 1 FROM social_post_media WHERE id = ${mediaId}::uuid`; const [p] = await tx<{ current_version_id: string }[]>`SELECT current_version_id FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL`;
      if (!x || !p) return fail('not_found', 'No such post or photograph.');
      await tx`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, photo_version_id, state, score, signals, decided_by, decided_at) VALUES (${userId}, ${mediaId}::uuid, ${photoId}::uuid, ${p.current_version_id}::uuid, 'USER_CONFIRMED', 1, ${tx.json({ manual: true } as never)}, 'USER', now())
               ON CONFLICT (social_post_media_id, photo_id) DO UPDATE SET state = 'USER_CONFIRMED', decided_by = 'USER', decided_at = now(), signals = photo_social_matches.signals || '{"manual": true}'::jsonb`;
      await tx`UPDATE photo_social_matches SET state = 'NO_MATCH' WHERE social_post_media_id = ${mediaId}::uuid AND photo_id <> ${photoId}::uuid AND decided_by = 'SYSTEM' AND state IN ('POSSIBLE_MATCH','HIGH_CONFIDENCE_MATCH','EXACT_MATCH')`;
      return ok(null);
    });
  }

  /** Has this photograph — or something very like it — been posted? Informs the composer and the viewer; it never blocks anything. */
  async postedCheck(userId: string, photoId: string): Promise<PostedCheck | Fail> {
    return withUser(this.sql, userId, async (tx) => (await postedCheckIn(tx, photoId)) ?? fail('not_found', 'No such photograph.'));
  }

  /** The stored image of an Instagram post, only for its owner. */
  async mediaFile(userId: string, mediaId: string): Promise<string | null> {
    if (!this.d.mediaDir) return null;
    const [r] = await withUser(this.sql, userId, (tx) => tx<{ file_relpath: string | null }[]>`SELECT file_relpath FROM social_post_media WHERE id = ${mediaId}::uuid`);
    if (!r?.file_relpath) return null;
    const abs = path.join(this.d.mediaDir, r.file_relpath); if (!abs.startsWith(this.d.mediaDir + path.sep) || !fs.existsSync(abs)) return null;
    return abs;
  }
}
