import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import sharp from 'sharp';
import { fingerprint } from '../ingest/hash.js';
import { PermanentJobError, type Handler } from '../jobs/worker.js';
import { LOCAL_EMBEDDING_DIMS, LOCAL_EMBEDDING_MODEL, embedFile, toVectorLiteral } from '../search/embedding.js';
import { captionOverlap, hashtagsOf, judge, type MatchState, type Signals } from './match.js';
import { GRAPH, GraphInstagramProvider, MockInstagramProvider, ProviderError, RateLimited, TokenExpired, fetchTransport, type InstagramProvider } from './provider.js';
import type { IgOAuthConfig, TokenVault } from './oauth.js';

/**
 * Sync and matching run in the worker / CLI under the SERVICE role, which is not row-restricted: every query below names the user.
 * Nothing here posts, edits or deletes anything on Instagram — it only reads — and nothing here changes a photograph in the library.
 */
export interface SyncResult { runId: string; status: 'OK' | 'PARTIAL' | 'FAILED'; postsSeen: number; postsNew: number; mediaFetched: number; mediaFailed: number; matched: number }
const MAX_BYTES = 40 * 1024 * 1024;
export const mediaRelpath = (sha: Buffer) => { const h = sha.toString('hex'); return `${h.slice(0, 2)}/${h}.jpg`; };

export class InstagramSync {
  constructor(private readonly sql: Sql, private readonly mediaDir: string, private readonly derivativesDir: string | null = null) {}

  async sync(userId: string, accountId: string, provider: InstagramProvider, o: { maxPages?: number } = {}): Promise<SyncResult> {
    const [acct] = await this.sql<{ id: string; external_id: string; platform: string }[]>`SELECT id, external_id, platform FROM social_accounts WHERE id = ${accountId}::uuid AND user_id = ${userId}::uuid`;
    if (!acct) throw new PermanentJobError('No such Instagram account.');
    if (provider.kind === 'mock' && !acct.external_id.startsWith('synthetic-')) throw new PermanentJobError('The synthetic archive can only be synced into a synthetic account.');
    if (provider.kind === 'graph' && acct.external_id.startsWith('synthetic-')) throw new PermanentJobError('A synthetic account is never synced from Instagram.');
    const [run] = await this.sql<{ id: string }[]>`INSERT INTO ig_sync_runs (user_id, social_account_id) VALUES (${userId}::uuid, ${accountId}::uuid) RETURNING id`;
    const r = { postsSeen: 0, postsNew: 0, mediaFetched: 0, mediaFailed: 0, matched: 0 }; const touched: string[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < (o.maxPages ?? 400); page++) {
        const pg = await provider.listPosts(cursor);
        for (const post of pg.posts) {
          r.postsSeen++;
          const [row] = await this.sql<{ id: string; inserted: boolean }[]>`
            INSERT INTO social_posts (user_id, social_account_id, platform_post_id, permalink, media_type, posted_at, caption, hashtags, origin, raw)
            VALUES (${userId}::uuid, ${accountId}::uuid, ${post.platformPostId}, ${post.permalink}, ${post.mediaType}, ${post.postedAt}::timestamptz, ${post.caption}, ${hashtagsOf(post.caption)}, 'SYNCED', ${this.sql.json(provider.kind === 'mock' ? { synthetic: true } : {})})
            ON CONFLICT (social_account_id, platform_post_id) DO UPDATE SET permalink = excluded.permalink, caption = excluded.caption, hashtags = excluded.hashtags, media_type = excluded.media_type
            RETURNING id, (xmax = 0) AS inserted`;
          if (row!.inserted) r.postsNew++;
          for (let pos = 0; pos < post.media.length; pos++) {
            const m = post.media[pos]!;
            const [existing] = await this.sql<{ id: string; fetched_at: Date | null }[]>`
              INSERT INTO social_post_media (user_id, social_post_id, position, platform_media_id) VALUES (${userId}::uuid, ${row!.id}::uuid, ${pos}, ${m.platformMediaId})
              ON CONFLICT (social_post_id, position) DO UPDATE SET platform_media_id = excluded.platform_media_id RETURNING id, fetched_at`;
            if (existing!.fetched_at) continue;                                                // already downloaded and fingerprinted: a re-sync is cheap and idempotent
            try { await this.storeMedia(userId, existing!.id, await provider.fetchMedia(m)); r.mediaFetched++; touched.push(existing!.id); }
            catch (e) { if (e instanceof TokenExpired || e instanceof RateLimited) throw e; r.mediaFailed++; }       // one bad image never stops the sync; it is retried next time
          }
        }
        if (!pg.next) break; cursor = pg.next;
      }
      if (touched.length) r.matched = (await this.match(userId, { mediaIds: touched })).matched;
    } catch (e) {
      const error = e instanceof Error ? e.message.slice(0, 300) : 'sync failed';
      if (e instanceof TokenExpired) await this.sql`UPDATE social_accounts SET status = 'EXPIRED', last_error = ${error} WHERE id = ${accountId}::uuid AND user_id = ${userId}::uuid`;
      else await this.sql`UPDATE social_accounts SET last_error = ${error} WHERE id = ${accountId}::uuid AND user_id = ${userId}::uuid`;
      await this.sql`UPDATE ig_sync_runs SET status = 'FAILED', finished_at = now(), error = ${error}, posts_seen = ${r.postsSeen}, posts_new = ${r.postsNew}, media_fetched = ${r.mediaFetched}, media_failed = ${r.mediaFailed} WHERE id = ${run!.id}::uuid`;
      if (e instanceof TokenExpired || e instanceof ProviderError) throw new PermanentJobError(error);            // needs a person (or a different request), not another try
      throw e;                                                                                                       // rate limits and I/O hiccups are retried with backoff
    }
    const status = r.mediaFailed > 0 ? 'PARTIAL' : 'OK';
    await this.sql`UPDATE ig_sync_runs SET status = ${status}, finished_at = now(), posts_seen = ${r.postsSeen}, posts_new = ${r.postsNew}, media_fetched = ${r.mediaFetched}, media_failed = ${r.mediaFailed}, matched = ${r.matched} WHERE id = ${run!.id}::uuid`;
    await this.sql`UPDATE social_accounts SET last_sync_at = now(), last_error = ${r.mediaFailed ? `${r.mediaFailed} image(s) could not be fetched; they will be retried` : null} WHERE id = ${accountId}::uuid AND user_id = ${userId}::uuid`;
    return { runId: run!.id, status, ...r };
  }

  /** Stores the image (content-addressed, so a re-download is a no-op), then records size, hashes and the local picture embedding. */
  async storeMedia(userId: string, mediaId: string, bytes: Buffer): Promise<void> {
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new ProviderError('The image is empty or too large.');
    const sha = crypto.createHash('sha256').update(bytes).digest(); const rel = mediaRelpath(sha); const abs = path.join(this.mediaDir, rel);
    const meta = await sharp(bytes, { failOn: 'error' }).metadata(); if (!meta.width || !meta.height) throw new ProviderError('Not a readable image.');
    const fp = await fingerprint(bytes);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try { await fs.access(abs); } catch { const tmp = `${abs}.${process.pid}.tmp`; await fs.writeFile(tmp, bytes, { mode: 0o600 }); await fs.rename(tmp, abs); }
    const vec = await embedFile(abs);
    await this.sql`UPDATE social_post_media SET file_relpath = ${rel}, width = ${meta.width}, height = ${meta.height}, sha256 = ${sha}, phash = ${fp.phash.toString()}::bigint, dhash = ${fp.dhash.toString()}::bigint,
                     embedding = ${toVectorLiteral(vec)}::halfvec, embedding_model = ${LOCAL_EMBEDDING_MODEL}, fetched_at = now() WHERE id = ${mediaId}::uuid AND user_id = ${userId}::uuid`;
  }

  /**
   * Proposes library photographs for Instagram images that have no verdict yet. Candidates come from two independent routes — a perceptual-hash
   * lookup (exact recall to distance 7) and the nearest picture embeddings (finds crops and edits) — and each is scored by `judge`.
   * Existing rows are never overwritten (a person's answer stays), and USER_REJECTED pairs are never proposed again.
   */
  /** Library pictures imported before the embedding existed get theirs now (local and free), so they can be compared with Instagram images by appearance. */
  private async ensureLibraryEmbeddings(userId: string): Promise<number> {
    if (!this.derivativesDir) return 0;
    const rows = await this.sql<{ id: string }[]>`SELECT v.id FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
      WHERE p.user_id = ${userId}::uuid AND p.deleted_at IS NULL AND v.deriv_status = 'READY'
        AND NOT EXISTS (SELECT 1 FROM photo_embeddings e WHERE e.photo_version_id = v.id AND e.model = ${LOCAL_EMBEDDING_MODEL} AND e.kind = 'image') LIMIT 2000`;
    let n = 0;
    for (const r of rows) {
      try {
        const vec = await embedFile(path.join(this.derivativesDir, r.id, 'thumb.jpg'));
        await this.sql`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${userId}::uuid, ${r.id}::uuid, ${LOCAL_EMBEDDING_MODEL}, 'image', ${LOCAL_EMBEDDING_DIMS}, ${toVectorLiteral(vec)}::halfvec) ON CONFLICT DO NOTHING`; n++;
      } catch { /* a missing or unreadable preview is skipped; the hash route still works for it */ }
    }
    return n;
  }

  async match(userId: string, o: { mediaIds?: string[]; all?: boolean } = {}): Promise<{ considered: number; matched: number; review: number }> {
    await this.ensureLibraryEmbeddings(userId);
    const media = await this.sql<Array<{ id: string; phash: string; dhash: string; sha256: Buffer; emb: string | null; posted_at: Date; caption: string | null; w: number; h: number }>>`
      SELECT m.id, m.phash::text AS phash, m.dhash::text AS dhash, m.sha256, m.embedding::text AS emb, sp.posted_at, sp.caption, m.width AS w, m.height AS h
        FROM social_post_media m JOIN social_posts sp ON sp.id = m.social_post_id
       WHERE m.user_id = ${userId}::uuid AND m.phash IS NOT NULL ${o.mediaIds ? this.sql`AND m.id = ANY(${o.mediaIds}::uuid[])` : this.sql``}
         AND NOT EXISTS (SELECT 1 FROM photo_social_matches x WHERE x.social_post_media_id = m.id AND (x.decided_by = 'USER' OR x.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH') OR ${o.all ? this.sql`false` : this.sql`true`}))     -- an image that already has a strong or human answer gets no weaker proposals
       ORDER BY sp.posted_at DESC LIMIT 5000`;
    let matched = 0, review = 0;
    for (const m of media) {
      const masks = [0, ...Array.from({ length: 16 }, (_, i) => 1 << i)];
      const seg = (shift: number) => { const v = Number((BigInt(m.phash) >> BigInt(shift)) & 0xffffn); return masks.map((k) => v ^ k); };
      const cands = await this.sql<Array<{ photo_id: string; version_id: string; pd: number | null; dd: number | null; same: boolean; sim: number | null; capture_at: Date | null; title: string | null; place: string | null }>>`
        WITH near AS (
          SELECT v.id AS vid FROM photo_versions v WHERE v.user_id = ${userId}::uuid AND v.phash IS NOT NULL
             AND (v.phash_s0 = ANY(${seg(48)}::int[]) OR v.phash_s1 = ANY(${seg(32)}::int[]) OR v.phash_s2 = ANY(${seg(16)}::int[]) OR v.phash_s3 = ANY(${seg(0)}::int[]))
          UNION
          SELECT e.photo_version_id FROM (SELECT photo_version_id FROM photo_embeddings WHERE user_id = ${userId}::uuid AND model = ${LOCAL_EMBEDDING_MODEL} AND kind = 'image' AND ${m.emb !== null}
                                           ORDER BY embedding::halfvec(${this.sql.unsafe(String(LOCAL_EMBEDDING_DIMS))}) <=> ${m.emb}::halfvec(${this.sql.unsafe(String(LOCAL_EMBEDDING_DIMS))}) LIMIT 6) e)
        SELECT p.id AS photo_id, v.id AS version_id, hamming64(v.phash, ${m.phash}::bigint) AS pd, hamming64(v.dhash, ${m.dhash}::bigint) AS dd, (v.content_sha256 = ${m.sha256}) AS same,
               CASE WHEN ${m.emb !== null} AND pe.embedding IS NOT NULL THEN 1 - (pe.embedding::halfvec(256) <=> ${m.emb}::halfvec(256)) END AS sim, p.capture_at, p.title, p.trip_location AS place
          FROM near n JOIN photo_versions v ON v.id = n.vid JOIN photos p ON p.id = v.photo_id AND p.current_version_id = v.id AND p.deleted_at IS NULL AND p.user_id = ${userId}::uuid
          LEFT JOIN photo_embeddings pe ON pe.photo_version_id = v.id AND pe.model = ${LOCAL_EMBEDDING_MODEL} AND pe.kind = 'image'
         WHERE NOT EXISTS (SELECT 1 FROM photo_social_matches x WHERE x.social_post_media_id = ${m.id}::uuid AND x.photo_id = p.id)`;
      const scored = cands.map((c) => {
        const sig: Signals = {
          sameBytes: c.same === true, phash: c.pd, dhash: c.dd, embedding: c.sim,
          dateConsistent: c.capture_at ? m.posted_at.getTime() >= c.capture_at.getTime() - 86_400_000 : null, captionOverlap: captionOverlap(m.caption, c.title, c.place),
        };
        return { c, sig, v: judge(sig) };
      }).filter((x) => x.v.state !== 'NO_MATCH').sort((a, b) => b.v.score - a.v.score);
      const top = scored[0]; if (!top) continue;
      const strong = top.v.state === 'EXACT_MATCH' || top.v.state === 'HIGH_CONFIDENCE_MATCH';
      const keep = (strong ? scored.filter((x) => x.v.state === 'EXACT_MATCH' || x.v.state === 'HIGH_CONFIDENCE_MATCH') : scored).slice(0, 3);
      for (const k of keep) {
        await this.sql`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, photo_version_id, state, phash_distance, embedding_similarity, score, signals)
          VALUES (${userId}::uuid, ${m.id}::uuid, ${k.c.photo_id}::uuid, ${k.c.version_id}::uuid, ${k.v.state satisfies MatchState}, ${k.c.pd}, ${k.c.sim}, ${k.v.score}, ${this.sql.json(k.sig as never)})
          ON CONFLICT (social_post_media_id, photo_id) DO NOTHING`;
      }
      matched++; if (!strong) review++;
    }
    return { considered: media.length, matched, review };
  }
}

/** Worker job `ig.sync` {accountId} and `ig.match` {all?}. Only the synthetic (local archive) provider is wired in this build. */
export function instagramHandlers(sql: Sql, mediaDir: string, derivativesDir: string | null = null, live?: { vault: TokenVault; cfg: IgOAuthConfig | null }): Record<string, Handler> {
  const svc = new InstagramSync(sql, mediaDir, derivativesDir);
  return {
    'ig.sync': async (job) => {
      const accountId = String(job.payload.accountId ?? ''); if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new PermanentJobError('malformed job: no account id');
      const [a] = await sql<{ external_id: string }[]>`SELECT external_id FROM social_accounts WHERE id = ${accountId}::uuid AND user_id = ${job.user_id}`;
      if (!a) throw new PermanentJobError('No such Instagram account.');
      if (a.external_id.startsWith('synthetic-')) { await svc.sync(job.user_id, accountId, new MockInstagramProvider(path.join(mediaDir, 'synthetic', job.user_id))); return; }
      // a connected account: read its history through the official API (a sandbox on this computer, or the real Instagram once you have approved it)
      if (!live?.cfg) throw new PermanentJobError('Syncing an Instagram account needs a Meta app and your approval; neither is configured.');
      const t = await live.vault.read(accountId, job.user_id); if (!t) throw new PermanentJobError('The Instagram account is not connected (or its token expired). Connect it again.');
      const graph = (live.cfg.graphBase ?? GRAPH).replace(/\/+$/, '');
      try { await svc.sync(job.user_id, accountId, new GraphInstagramProvider({ enabled: true, igUserId: t.igUserId, token: () => t.token, transport: fetchTransport(), baseUrl: graph, live: live.cfg.live === true })); }
      catch (e) { if (e instanceof TokenExpired) { await sql`UPDATE social_accounts SET status = 'EXPIRED', last_error = 'Instagram says the token expired or was revoked; connect the account again.' WHERE id = ${accountId}::uuid`; throw new PermanentJobError(e.message); } throw e; }
    },
    'ig.token.refresh': async () => { if (live) await live.vault.refreshDue(); },
    'ig.match': async (job) => { await svc.match(job.user_id, { all: job.payload.all === true }); },
  };
}
