import fs from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import { backoffSeconds } from '../jobs/worker.js';
import { AlreadyPublished, AuthExpired, PermanentGraphError, TransientGraphError, UnknownOutcome, type GraphMedia, type GraphPublisher } from './graph.js';
import { AspectError, prepareDeliveryImage, type DeliveredImage, type DeliveryProvider } from './delivery.js';

/**
 * The publisher: a lease-based, restart-safe procedure that turns an APPROVED, SCHEDULED, DUE post into a verified Instagram post.
 *
 *   claim (lease) → PREFLIGHT → CREATE_CONTAINER (persist container id) → POLL_STATUS → [persist publish_requested_at] → PUBLISH → VERIFY → PUBLISHED
 *
 * Rules that keep it from ever posting twice or posting what nobody approved:
 *  - only SCHEDULED rows whose draft is approved and whose time has come are claimed (SKIP LOCKED + lease); a post more than 15 minutes late is NOT
 *    published — it fails as LATE and a person chooses a new time;
 *  - the container id is stored before publishing and `publish_requested_at` is committed BEFORE the publish request is sent;
 *  - after that moment a publish is never repeated automatically: an ambiguous answer becomes an UNKNOWN OUTCOME and is only RECONCILED
 *    (look for a post with exactly this caption since the request), then, if nothing shows up within the grace window, FAILED for a person to check;
 *  - PUBLISHED needs the post to be read back from Instagram and its caption to match (the database enforces verified_at + platform id).
 * It runs only when the worker is started with `--publisher mock`, against the local mock Graph server. A live mode does not exist in this build.
 */
export const LATE_MS = 15 * 60_000, GRACE_MS = 15 * 60_000, LEASE_MS = 5 * 60_000, POLL_LIMIT = 6;
export interface PublisherDeps { sql: Sql; graph: GraphPublisher; delivery: DeliveryProvider; libraryFile?: (v: { root: string; relpath: string; versionId: string }) => Promise<string | null>; now?: () => Date; sleep?: (ms: number) => Promise<void>; instance?: string; mock?: boolean; storeMedia?: (userId: string, mediaRowId: string, jpeg: Buffer) => Promise<void> }
export interface TickResult { claimed: number; published: number; failed: number; retried: number; reconciled: number; late: number }

interface Pub { id: string; user_id: string; draft_id: string; scheduled_at: Date; timezone: string; attempt_count: number; max_attempts: number; container_id: string | null; publish_requested_at: Date | null; platform_post_id: string | null; verified_at: Date | null; idempotency_key: string; error_code: string | null }
interface Draft { photo_id: string; photo_version_id: string; caption_body: string; hashtags: string[]; state: string; approved_at: Date | null; history_check: { kind?: string } | null; history_override_at: Date | null; social_account_id: string | null }
const finalText = (d: Draft) => (d.hashtags.length ? `${d.caption_body}\n\n${d.hashtags.map((t) => `#${t}`).join(' ')}` : d.caption_body);
class Stop extends Error { constructor(public readonly kind: 'fail' | 'retry' | 'unknown' | 'done', public readonly code: string, msg: string, public readonly retryAfter?: number) { super(msg); } }

export class Publisher {
  private readonly now: () => Date; private readonly sleep: (ms: number) => Promise<void>; private readonly id: string;
  constructor(private readonly d: PublisherDeps) { this.now = d.now ?? (() => new Date()); this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); this.id = d.instance ?? `publisher-${process.pid}`; }

  async tick(max = 3): Promise<TickResult> {
    const r: TickResult = { claimed: 0, published: 0, failed: 0, retried: 0, reconciled: 0, late: 0 };
    const now = this.now(); const sql = this.d.sql;
    // 1. posts that missed their time by more than the allowed lateness are NOT published
    const late = await sql<{ id: string }[]>`UPDATE scheduled_publications SET state = 'FAILED', error_code = 'LATE', error_message = 'It was not published at its scheduled time and is now too late to publish automatically. Choose a new time.', locked_by = NULL, locked_until = NULL
        WHERE state = 'SCHEDULED' AND scheduled_at < ${new Date(now.getTime() - LATE_MS)} AND publish_requested_at IS NULL RETURNING id`;
    r.late = late.length;
    // 2. posts whose worker died (lease expired) or whose outcome was ambiguous
    const stale = await sql<Pub[]>`SELECT * FROM scheduled_publications WHERE state = 'PUBLISHING' AND locked_until < ${now} ORDER BY scheduled_at LIMIT ${max}`;
    for (const p of stale) {
      const claimed = await sql<Pub[]>`UPDATE scheduled_publications SET locked_by = ${this.id}, locked_until = ${new Date(now.getTime() + LEASE_MS)} WHERE id = ${p.id}::uuid AND state = 'PUBLISHING' AND locked_until < ${now} RETURNING *`;
      if (!claimed[0]) continue; r.claimed++;
      const out = await this.run(claimed[0]);
      if (out === 'published') { r.published++; r.reconciled++; } else if (out === 'failed') r.failed++; else if (out === 'retry') r.retried++;
    }
    // 3. due posts, oldest first
    const due = await sql<Pub[]>`UPDATE scheduled_publications SET state = 'PUBLISHING', locked_by = ${this.id}, locked_until = ${new Date(now.getTime() + LEASE_MS)}, attempt_count = attempt_count + 1, last_attempt_at = ${now}
        WHERE id IN (SELECT s.id FROM scheduled_publications s JOIN publishing_drafts d ON d.id = s.draft_id
                      WHERE s.state = 'SCHEDULED' AND s.scheduled_at <= ${now} AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ${now}) AND d.approved_at IS NOT NULL AND d.state = 'SCHEDULED'
                      ORDER BY s.scheduled_at LIMIT ${max} FOR UPDATE OF s SKIP LOCKED) RETURNING *`;
    for (const p of due) {
      r.claimed++; const out = await this.run(p);
      if (out === 'published') r.published++; else if (out === 'failed') r.failed++; else if (out === 'retry') r.retried++;
    }
    return r;
  }

  private async attempt<T>(p: Pub, phase: 'PREFLIGHT' | 'CREATE_CONTAINER' | 'POLL_STATUS' | 'PUBLISH' | 'VERIFY' | 'RECONCILE', f: () => Promise<T>): Promise<T> {
    const sql = this.d.sql; const [a] = await sql<{ id: string }[]>`INSERT INTO publication_attempts (user_id, scheduled_publication_id, phase, started_at) VALUES (${p.user_id}::uuid, ${p.id}::uuid, ${phase}, now()) RETURNING id`;
    try { const v = await f(); await sql`UPDATE publication_attempts SET finished_at = now(), outcome = 'OK' WHERE id = ${a!.id}::uuid`; return v; }
    catch (e) {
      const unknown = e instanceof UnknownOutcome || (e instanceof Stop && e.kind === 'unknown'); const code = e instanceof Stop ? e.code : e instanceof Error ? e.constructor.name : 'ERROR';
      await sql`UPDATE publication_attempts SET finished_at = now(), outcome = ${unknown ? 'UNKNOWN' : 'FAILED'}, error_code = ${code}, platform_error = ${sql.json({ message: e instanceof Error ? e.message.slice(0, 200) : 'error' } as never)} WHERE id = ${a!.id}::uuid`; throw e;
    }
  }

  private async run(p: Pub): Promise<'published' | 'failed' | 'retry' | 'pending'> {
    const sql = this.d.sql; const now = this.now(); let delivered: DeliveredImage | null = null; let keepDelivery = false;
    try {
      const [d] = await sql<Draft[]>`SELECT photo_id, photo_version_id, caption_body, hashtags, state, approved_at, history_check, history_override_at, social_account_id FROM publishing_drafts WHERE id = ${p.draft_id}::uuid AND user_id = ${p.user_id}::uuid`;
      if (!d) throw new Stop('fail', 'NO_DRAFT', 'The draft no longer exists.');
      const text = finalText(d);

      // a post whose publish request may have gone out: never publish again; look for it, or leave it for a person
      if (p.publish_requested_at && !p.platform_post_id) {
        if (p.error_code !== null) return await this.reconcile(p, d, text);                      // the automatic path: only ever look, never publish again
        // a person chose to try again after an unknown outcome: first make sure the post really is not there
        const there = await this.lookup(p, text);
        if (there) { await sql`UPDATE scheduled_publications SET platform_post_id = ${there.id} WHERE id = ${p.id}::uuid`; return await this.verify(p, d, text, there.id, null); }
        await sql`UPDATE scheduled_publications SET container_id = NULL, publish_requested_at = NULL WHERE id = ${p.id}::uuid`; p.container_id = null; p.publish_requested_at = null;
      }
      if (p.platform_post_id && !p.verified_at) return await this.verify(p, d, text, p.platform_post_id, null);

      await this.attempt(p, 'PREFLIGHT', async () => {
        if (d.state !== 'SCHEDULED' || !d.approved_at) throw new Stop('fail', 'NOT_APPROVED', 'The draft is not approved and scheduled.');
        if (d.history_check?.kind && d.history_check.kind !== 'none' && !d.history_override_at) throw new Stop('fail', 'HISTORY_NOT_ACKNOWLEDGED', 'It was posted before and you have not confirmed posting it again.');
        if (!d.caption_body.trim()) throw new Stop('fail', 'NO_CAPTION', 'The caption is empty.');
        const [acct] = await sql<{ id: string; external_id: string; status: string }[]>`SELECT id, external_id, status FROM social_accounts WHERE user_id = ${p.user_id}::uuid AND platform = 'instagram' ${d.social_account_id ? sql`AND id = ${d.social_account_id}::uuid` : sql``} ORDER BY created_at LIMIT 1`;
        if (!acct) throw new Stop('fail', 'NO_ACCOUNT', 'No Instagram account is set up to publish to.');
        if (this.d.mock && !acct.external_id.startsWith('synthetic-')) throw new Stop('fail', 'MOCK_ONLY', 'This build publishes only to the local mock; a real account is never contacted.');
      });
      let jpeg: Buffer | null = null;
      if (!p.container_id) {
        jpeg = await this.attempt(p, 'PREFLIGHT', async () => {
          const file = await this.source(p, d); if (!file) throw new Stop('fail', 'NO_IMAGE', 'The photograph’s file could not be found.');
          try { return (await prepareDeliveryImage(file)).jpeg; } catch (e) { if (e instanceof AspectError) throw new Stop('fail', 'ASPECT_RATIO', e.message); throw new Stop('fail', 'BAD_IMAGE', 'The photograph could not be read as an image.'); }
        });
        delivered = await this.d.delivery.prepare({ userId: p.user_id, publicationId: p.id, jpeg });
        const c = await this.attempt(p, 'CREATE_CONTAINER', () => this.d.graph.createContainer({ imageUrl: delivered!.url, caption: text, clientKey: `${p.idempotency_key}:${Math.random().toString(36).slice(2, 10)}` }));
        await sql`UPDATE scheduled_publications SET container_id = ${c.id} WHERE id = ${p.id}::uuid`; p.container_id = c.id;          // persisted BEFORE anything can publish it
      }
      await this.attempt(p, 'POLL_STATUS', async () => {
        for (let i = 0; i < POLL_LIMIT; i++) {
          const s = await this.d.graph.containerStatus(p.container_id!);
          if (s.status === 'FINISHED') return;
          if (s.status === 'ERROR') throw new Stop('fail', 'CONTAINER_ERROR', s.error ?? 'Instagram rejected the image.');
          if (s.status === 'EXPIRED') { await sql`UPDATE scheduled_publications SET container_id = NULL WHERE id = ${p.id}::uuid`; throw new Stop('retry', 'CONTAINER_EXPIRED', 'The upload expired; trying again.'); }
          await this.sleep(Math.min(2000 * (i + 1), 8000));
        }
        throw new Stop('retry', 'NOT_READY', 'Instagram is still processing the image.');
      });
      // the point of no return: committed BEFORE the request, so a crash after this can only ever lead to reconciliation
      await sql`UPDATE scheduled_publications SET publish_requested_at = ${this.now()} WHERE id = ${p.id}::uuid`;
      let mediaId: string;
      try { mediaId = (await this.attempt(p, 'PUBLISH', () => this.d.graph.publish(p.container_id!))).mediaId; }
      catch (e) {
        if (e instanceof UnknownOutcome) { await sql`UPDATE scheduled_publications SET error_code = 'UNKNOWN_OUTCOME', error_message = 'The publish request got no clear answer. Looking for the post…' WHERE id = ${p.id}::uuid`; p.error_code = 'UNKNOWN_OUTCOME'; return await this.reconcile(p, d, text); }
        if (e instanceof AlreadyPublished) return await this.reconcile(p, d, text);
        throw e;
      }
      await sql`UPDATE scheduled_publications SET platform_post_id = ${mediaId} WHERE id = ${p.id}::uuid`;
      return await this.verify(p, d, text, mediaId, jpeg);
    } catch (e) { if (e instanceof Stop && e.code === 'NOT_READY') keepDelivery = true;       // Instagram has not fetched the image yet: the link must outlive this attempt
      return await this.settle(p, e, now); }
    finally { if (delivered && !keepDelivery) await delivered.revoke().catch(() => undefined); }
  }

  private async source(p: Pub, d: Draft): Promise<string | null> {
    const [v] = await this.d.sql<{ id: string; relpath: string; root: string }[]>`SELECT v.id, v.source_relpath AS relpath, r.path AS root FROM photo_versions v JOIN library_roots r ON r.id = v.library_root_id WHERE v.id = ${d.photo_version_id}::uuid AND v.user_id = ${p.user_id}::uuid`;
    if (!v) return null;
    if (this.d.libraryFile) return this.d.libraryFile({ root: v.root, relpath: v.relpath, versionId: v.id });
    const abs = path.resolve(v.root, v.relpath); if (!abs.startsWith(path.resolve(v.root) + path.sep)) return null;
    try { await fs.access(abs); return abs; } catch { return null; }
  }

  private async verify(p: Pub, d: Draft, text: string, mediaId: string, jpeg: Buffer | null): Promise<'published' | 'failed'> {
    const m = await this.attempt(p, 'VERIFY', async () => {
      const got = await this.d.graph.getMedia(mediaId); if (!got) throw new Stop('fail', 'VERIFY_FAILED', 'Instagram did not return the post that was just published. Check your Instagram account before trying again.');
      if (got.caption.trim() !== text.trim()) throw new Stop('fail', 'VERIFY_FAILED', 'The post on Instagram does not carry the approved caption. Check your Instagram account.');
      return got;
    });
    await this.finish(p, d, m, jpeg); return 'published';
  }

  /** Records the verified post: the schedule, the draft, the history archive (as our own post) and the link between the post and the photograph. */
  private async finish(p: Pub, d: Draft, m: GraphMedia, jpeg: Buffer | null): Promise<void> {
    const sql = this.d.sql; const when = this.now();
    const row = await sql.begin(async (tx): Promise<string | null> => {
      await tx`UPDATE scheduled_publications SET state = 'PUBLISHED', platform_post_id = ${m.id}, permalink = ${m.permalink}, published_at = ${new Date(m.timestamp)}, verified_at = ${when}, error_code = NULL, error_message = NULL, locked_by = NULL, locked_until = NULL WHERE id = ${p.id}::uuid`;
      await tx`UPDATE publishing_drafts SET state = 'PUBLISHED' WHERE id = ${p.draft_id}::uuid`;
      const [acct] = await tx<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${p.user_id}::uuid AND platform = 'instagram' ${d.social_account_id ? tx`AND id = ${d.social_account_id}::uuid` : tx``} ORDER BY created_at LIMIT 1`;
      if (!acct) return null;
      const [post] = await tx<{ id: string }[]>`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, permalink, media_type, posted_at, caption, hashtags, origin, raw) VALUES (${p.user_id}::uuid, ${acct.id}::uuid, ${m.id}, ${m.permalink}, 'IMAGE', ${new Date(m.timestamp)}, ${m.caption}, ${d.hashtags.map((t) => t.toLowerCase())}, 'APP_PUBLISHED', ${tx.json({ ...(this.d.mock ? { synthetic: true, mock: true } : {}) } as never)})
        ON CONFLICT (social_account_id, platform_post_id) DO UPDATE SET caption = excluded.caption RETURNING id`;
      const [media] = await tx<{ id: string }[]>`INSERT INTO social_post_media (user_id, social_post_id, position, platform_media_id) VALUES (${p.user_id}::uuid, ${post!.id}::uuid, 0, ${m.id}) ON CONFLICT (social_post_id, position) DO UPDATE SET platform_media_id = excluded.platform_media_id RETURNING id`;
      await tx`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, photo_version_id, state, score, signals) VALUES (${p.user_id}::uuid, ${media!.id}::uuid, ${d.photo_id}::uuid, ${d.photo_version_id}::uuid, 'EXACT_MATCH', 1, ${tx.json({ published: true, byApp: true } as never)}) ON CONFLICT (social_post_media_id, photo_id) DO NOTHING`;
      return media!.id;
    });
    if (row && jpeg && this.d.storeMedia) await this.d.storeMedia(p.user_id, row, jpeg).catch(() => undefined);
  }

  private async lookup(p: Pub, text: string): Promise<GraphMedia | undefined> {
    const since = new Date((p.publish_requested_at ?? this.now()).getTime() - 120_000);
    return this.attempt(p, 'RECONCILE', async () => (await this.d.graph.recentMedia(25)).find((m) => m.caption.trim() === text.trim() && new Date(m.timestamp) >= since));
  }
  /** An ambiguous publish: find the post by its exact caption among recent media; never publish again. */
  private async reconcile(p: Pub, d: Draft, text: string): Promise<'published' | 'failed' | 'pending'> {
    let found: GraphMedia | undefined;
    try { found = await this.lookup(p, text); } catch (e) { if (e instanceof TransientGraphError) return 'pending'; throw e; }
    if (found) { await this.d.sql`UPDATE scheduled_publications SET platform_post_id = ${found.id} WHERE id = ${p.id}::uuid`; return this.verify(p, d, text, found.id, null); }
    if (this.now().getTime() - (p.publish_requested_at ?? this.now()).getTime() < GRACE_MS) { await this.d.sql`UPDATE scheduled_publications SET error_code = 'UNKNOWN_OUTCOME', locked_until = ${new Date(this.now().getTime() + 60_000)} WHERE id = ${p.id}::uuid`; return 'pending'; }
    throw new Stop('fail', 'UNKNOWN_OUTCOME', 'It is not known whether this post was published: Instagram did not confirm it and it was not found. Check your Instagram account. If it is not there, choose a new time to try again.');
  }

  private async settle(p: Pub, e: unknown, now: Date): Promise<'failed' | 'retry' | 'pending'> {
    const sql = this.d.sql; const msg = e instanceof Error ? e.message.slice(0, 300) : 'Unexpected error';
    const fail = async (code: string, message: string) => {
      await sql`UPDATE scheduled_publications SET state = 'FAILED', error_code = ${code}, error_message = ${message}, locked_by = NULL, locked_until = NULL, next_attempt_at = NULL WHERE id = ${p.id}::uuid`;
      await sql`UPDATE publishing_drafts SET state = 'SCHEDULED' WHERE id = ${p.draft_id}::uuid AND state <> 'PUBLISHED'`; return 'failed' as const;
    };
    if (e instanceof Stop) {
      if (e.kind === 'fail') return fail(e.code, e.message);
      if (e.kind === 'retry') return this.retry(p, e.code, e.message, now);
    }
    if (e instanceof AuthExpired) { await sql`UPDATE social_accounts SET status = 'EXPIRED', last_error = 'The access token expired' WHERE user_id = ${p.user_id}::uuid AND platform = 'instagram'`; return fail('AUTH', 'The Instagram connection has expired. Reconnect the account, then choose a time to try again.'); }
    if (e instanceof TransientGraphError) return this.retry(p, 'TRANSIENT', e.message, now, e.retryAfterSeconds);
    if (e instanceof PermanentGraphError) return fail('REJECTED', e.message);
    return this.retry(p, 'ERROR', msg, now);
  }
  private async retry(p: Pub, code: string, message: string, now: Date, retryAfter?: number): Promise<'failed' | 'retry'> {
    const sql = this.d.sql;
    if (p.attempt_count >= p.max_attempts) {
      await sql`UPDATE scheduled_publications SET state = 'FAILED', error_code = 'RETRIES_EXHAUSTED', error_message = ${`Gave up after ${p.attempt_count} attempts: ${message}`}, locked_by = NULL, locked_until = NULL WHERE id = ${p.id}::uuid`; return 'failed';
    }
    const wait = Math.max(retryAfter ?? 0, backoffSeconds(p.attempt_count, 30));
    await sql`UPDATE scheduled_publications SET state = 'SCHEDULED', error_code = ${code}, error_message = ${message}, locked_by = NULL, locked_until = NULL, next_attempt_at = ${new Date(now.getTime() + wait * 1000)} WHERE id = ${p.id}::uuid`; return 'retry';
  }
}
