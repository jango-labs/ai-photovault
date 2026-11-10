import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { LibraryService, type PhotoCard } from './service.js';

export const DEFAULT_MAX_DISTANCE = 6;
export const ScanSchema = z.object({ maxDistance: z.number().int().min(0).max(7).default(DEFAULT_MAX_DISTANCE) }).strict();
export const DecideSchema = z.object({ state: z.enum(['DUPLICATE', 'DISTINCT', 'OPEN']) }).strict();

export interface PairView { id: string; distance: number; state: 'OPEN' | 'DUPLICATE' | 'DISTINCT'; detectedAt: string; a: PhotoCard; b: PhotoCard }

/**
 * Near-duplicate identification from 64-bit perceptual hashes. Two hashes within Hamming distance ≤ 3 share at least one of four
 * 16-bit segments (multi-index hashing), and larger thresholds are filtered exactly, so each segment join is an indexed equality
 * join: the whole catalogue is scanned in one set-based statement and the result is remembered. A pair the user marks DISTINCT is
 * never proposed again. Nothing here deletes, hides or merges a photograph; resolving a pair is a human decision.
 */
export class DuplicateService {
  private readonly lib: LibraryService;
  constructor(private readonly sql: Sql) { this.lib = new LibraryService(sql); }

  /**
   * Exact recall for every distance ≤ `maxDistance` (≤ 7). Pigeonhole: with d ≤ 3 at least one of the four 16-bit segments is identical;
   * with d ≤ 7 at least one segment differs in ≤ 1 bit. So candidates are found by indexed equality joins of each segment against the
   * other photograph's segment XOR a mask (no mask, or no/one-bit masks), then filtered by the exact Hamming distance.
   */
  async scan(userId: string, maxDistance = DEFAULT_MAX_DISTANCE): Promise<{ found: number; open: number }> {
    const masks = maxDistance <= 3 ? [0] : [0, ...Array.from({ length: 16 }, (_, i) => 1 << i)];
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx`
        WITH cur AS (
          SELECT v.photo_id, v.phash, v.phash_s0, v.phash_s1, v.phash_s2, v.phash_s3
            FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
           WHERE p.user_id = ${userId}::uuid AND p.deleted_at IS NULL AND v.phash IS NOT NULL      -- explicit: the worker's role is not row-restricted
        ), m AS (SELECT unnest(${masks}::int[]) AS mask), cand AS (
          SELECT a.photo_id AS x, b.photo_id AS y, hamming64(a.phash, b.phash) AS d FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s0 = (a.phash_s0 # m.mask) AND a.photo_id < b.photo_id
          UNION SELECT a.photo_id, b.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s1 = (a.phash_s1 # m.mask) AND a.photo_id < b.photo_id
          UNION SELECT a.photo_id, b.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s2 = (a.phash_s2 # m.mask) AND a.photo_id < b.photo_id
          UNION SELECT a.photo_id, b.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s3 = (a.phash_s3 # m.mask) AND a.photo_id < b.photo_id
          UNION SELECT b.photo_id, a.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s0 = (a.phash_s0 # m.mask) AND b.photo_id < a.photo_id
          UNION SELECT b.photo_id, a.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s1 = (a.phash_s1 # m.mask) AND b.photo_id < a.photo_id
          UNION SELECT b.photo_id, a.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s2 = (a.phash_s2 # m.mask) AND b.photo_id < a.photo_id
          UNION SELECT b.photo_id, a.photo_id, hamming64(a.phash, b.phash) FROM cur a CROSS JOIN m JOIN cur b ON b.phash_s3 = (a.phash_s3 # m.mask) AND b.photo_id < a.photo_id
        )
        INSERT INTO duplicate_pairs (user_id, photo_a, photo_b, distance)
        SELECT ${userId}::uuid, x, y, d FROM cand WHERE d <= ${maxDistance}
        ON CONFLICT (photo_a, photo_b) DO NOTHING RETURNING 1`;
      const [o] = await tx<{ n: string }[]>`SELECT count(*) AS n FROM duplicate_pairs WHERE state = 'OPEN'`;
      return { found: rows.length, open: Number(o!.n) };
    });
  }

  /** Compares only the given (newly hashed) photographs with the rest of the library; same exact guarantee as scan(). */
  async detectFor(userId: string, photoIds: string[], maxDistance = DEFAULT_MAX_DISTANCE): Promise<number> {
    if (!photoIds.length) return 0;
    const masks = maxDistance <= 3 ? [0] : [0, ...Array.from({ length: 16 }, (_, i) => 1 << i)];
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx`
        WITH nw AS (
          SELECT v.photo_id, v.phash, v.phash_s0, v.phash_s1, v.phash_s2, v.phash_s3 FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
           WHERE p.user_id = ${userId}::uuid AND p.id = ANY(${photoIds}::uuid[]) AND p.deleted_at IS NULL AND v.phash IS NOT NULL
        ), m AS (SELECT unnest(${masks}::int[]) AS mask), cand AS (
          SELECT a.photo_id AS x, b.photo_id AS y, hamming64(a.phash, b.phash) AS d FROM nw a CROSS JOIN m JOIN photo_versions b ON b.user_id = ${userId}::uuid AND b.phash_s0 = (a.phash_s0 # m.mask) AND b.photo_id <> a.photo_id
          UNION SELECT a.photo_id, b.photo_id, hamming64(a.phash, b.phash) FROM nw a CROSS JOIN m JOIN photo_versions b ON b.user_id = ${userId}::uuid AND b.phash_s1 = (a.phash_s1 # m.mask) AND b.photo_id <> a.photo_id
          UNION SELECT a.photo_id, b.photo_id, hamming64(a.phash, b.phash) FROM nw a CROSS JOIN m JOIN photo_versions b ON b.user_id = ${userId}::uuid AND b.phash_s2 = (a.phash_s2 # m.mask) AND b.photo_id <> a.photo_id
          UNION SELECT a.photo_id, b.photo_id, hamming64(a.phash, b.phash) FROM nw a CROSS JOIN m JOIN photo_versions b ON b.user_id = ${userId}::uuid AND b.phash_s3 = (a.phash_s3 # m.mask) AND b.photo_id <> a.photo_id
        )
        INSERT INTO duplicate_pairs (user_id, photo_a, photo_b, distance)
        SELECT ${userId}::uuid, least(c.x, c.y), greatest(c.x, c.y), c.d FROM cand c
          JOIN photos pb ON pb.id = c.y AND pb.deleted_at IS NULL AND pb.current_version_id = (SELECT id FROM photo_versions WHERE photo_id = c.y AND state = 'ACTIVE')
         WHERE c.d <= ${maxDistance}
        ON CONFLICT (photo_a, photo_b) DO NOTHING RETURNING 1`;
      return rows.length;
    });
  }

  private async pairViews(userId: string, rows: Array<{ id: string; photo_a: string; photo_b: string; distance: number; state: PairView['state']; detected_at: Date }>): Promise<PairView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.photo_a, r.photo_b]))];
    const cards = new Map((await this.lib.cards(userId, ids)).map((c) => [c.id, c]));
    return rows.flatMap((r) => {
      const a = cards.get(r.photo_a), b = cards.get(r.photo_b);
      return a && b ? [{ id: r.id, distance: r.distance, state: r.state, detectedAt: r.detected_at.toISOString(), a, b }] : [];
    });
  }

  /** Pairs by state, most similar first. Keyset on (distance, id). */
  async list(userId: string, o: { state: 'OPEN' | 'DUPLICATE' | 'DISTINCT'; limit: number; cursor?: { d: number; id: string } }) {
    const rows = await withUser(this.sql, userId, (tx) => tx<Array<{ id: string; photo_a: string; photo_b: string; distance: number; state: PairView['state']; detected_at: Date }>>`
      SELECT id, photo_a, photo_b, distance, state, detected_at FROM duplicate_pairs
       WHERE state = ${o.state} ${o.cursor ? tx`AND (distance, id) > (${o.cursor.d}::int, ${o.cursor.id}::uuid)` : tx``}
       ORDER BY distance, id LIMIT ${o.limit + 1}`);
    const page = rows.slice(0, o.limit);
    const total = await withUser(this.sql, userId, async (tx) => Number((await tx<{ n: string }[]>`SELECT count(*) AS n FROM duplicate_pairs WHERE state = ${o.state}`)[0]!.n));
    const last = page[page.length - 1];
    return { items: await this.pairViews(userId, page), total, next: rows.length > o.limit && last ? { d: last.distance, id: last.id } : null };
  }

  async forPhoto(userId: string, photoId: string): Promise<Array<PairView & { other: PhotoCard }> | null> {
    const rows = await withUser(this.sql, userId, async (tx) => {
      const [p] = await tx`SELECT 1 FROM photos WHERE id = ${photoId}::uuid`;
      if (!p) return null;
      return tx<Array<{ id: string; photo_a: string; photo_b: string; distance: number; state: PairView['state']; detected_at: Date }>>`
        SELECT id, photo_a, photo_b, distance, state, detected_at FROM duplicate_pairs WHERE (photo_a = ${photoId}::uuid OR photo_b = ${photoId}::uuid) AND state <> 'DISTINCT' ORDER BY distance, id`;
    });
    if (!rows) return null;
    return (await this.pairViews(userId, rows)).map((v) => ({ ...v, other: v.a.id === photoId ? v.b : v.a }));
  }

  async decide(userId: string, pairId: string, state: 'OPEN' | 'DUPLICATE' | 'DISTINCT'): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx`UPDATE duplicate_pairs SET state = ${state}, decided_at = ${state === 'OPEN' ? null : new Date()} WHERE id = ${pairId}::uuid RETURNING id`;
      return rows.length === 1;
    });
  }
}
