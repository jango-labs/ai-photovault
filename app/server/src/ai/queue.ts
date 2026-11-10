import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';

/**
 * The owner's view of, and control over, background AI processing: how much is waiting, how fast it is going, pause / resume, cancel what has not
 * started, move recent photographs to the front, and what happened lately. Controls only ever touch the owner's own queued jobs (row-level security);
 * a job that is already running finishes. Nothing here starts any analysis by itself.
 */
export const AI_KINDS = ['ai.analyze', 'embed.image', 'embed.text'] as const;
export const QUEUES = ['ai', 'previews'] as const;
export const QueueSchema = z.object({ queue: z.enum(QUEUES).default('ai') }).strict();
export const PrioritizeSchema = z.union([
  z.object({ photoIds: z.array(z.string().uuid()).min(1).max(5000) }).strict(),
  z.object({ importedWithinHours: z.number().int().min(1).max(24 * 365) }).strict(),
  z.object({ reset: z.literal(true) }).strict(),
]);
const BOOST = 5;

export interface QueueStatus {
  paused: boolean; previewsPaused: boolean;
  waiting: number; running: number; done24h: number; failed24h: number; cancelled: number; gaveUp: number; prioritised: number;
  secondsPerItem: number | null; etaSeconds: number | null; oldestWaitingSeconds: number | null;
  perKind: Array<{ kind: string; waiting: number; running: number }>;
}
export interface HistoryRow { id: string; kind: string; outcome: string | null; startedAt: string; seconds: number | null; error: string | null; photoId: string | null; title: string | null }

export class AiQueue {
  constructor(private readonly sql: Sql) {}

  async status(userId: string): Promise<QueueStatus> {
    return withUser(this.sql, userId, async (tx) => {
      const [c] = await tx<{ waiting: number; running: number; done24h: number; failed24h: number; cancelled: number; gave_up: number; boosted: number; oldest: number | null }[]>`
        SELECT count(*) FILTER (WHERE state='QUEUED')::int AS waiting, count(*) FILTER (WHERE state='RUNNING')::int AS running,
               count(*) FILTER (WHERE state='SUCCEEDED' AND finished_at > now() - interval '24 hours')::int AS done24h,
               count(*) FILTER (WHERE state='FAILED' AND finished_at > now() - interval '24 hours')::int AS failed24h,
               count(*) FILTER (WHERE state='CANCELLED')::int AS cancelled, count(*) FILTER (WHERE state='DEAD')::int AS gave_up,
               count(*) FILTER (WHERE state='QUEUED' AND priority > 0)::int AS boosted,
               extract(epoch FROM now() - min(created_at) FILTER (WHERE state='QUEUED'))::int AS oldest
          FROM jobs WHERE kind = ANY (${AI_KINDS as unknown as string[]}) AND (state IN ('QUEUED','RUNNING','DEAD') OR created_at > now() - interval '30 days')`;
      const kinds = await tx<{ kind: string; waiting: number; running: number }[]>`
        SELECT kind, count(*) FILTER (WHERE state='QUEUED')::int AS waiting, count(*) FILTER (WHERE state='RUNNING')::int AS running
          FROM jobs WHERE kind = ANY (${AI_KINDS as unknown as string[]}) AND state IN ('QUEUED','RUNNING') GROUP BY kind ORDER BY kind`;
      const [speed] = await tx<{ s: number | null }[]>`
        SELECT avg(extract(epoch FROM a.finished_at - a.started_at))::float AS s FROM (
          SELECT a.finished_at, a.started_at FROM job_attempts a JOIN jobs j ON j.id = a.job_id
           WHERE j.kind = 'ai.analyze' AND a.outcome = 'OK' AND a.finished_at IS NOT NULL ORDER BY a.started_at DESC LIMIT 50) a`;
      const ctl = await tx<{ queue: string; paused: boolean }[]>`SELECT queue, paused FROM queue_controls`;
      const analyseWaiting = kinds.find((k) => k.kind === 'ai.analyze')?.waiting ?? 0;
      const s = speed?.s ?? null;
      return {
        paused: ctl.find((x) => x.queue === 'ai')?.paused ?? false, previewsPaused: ctl.find((x) => x.queue === 'previews')?.paused ?? false,
        waiting: c!.waiting, running: c!.running, done24h: c!.done24h, failed24h: c!.failed24h, cancelled: c!.cancelled, gaveUp: c!.gave_up, prioritised: c!.boosted,
        secondsPerItem: s === null ? null : Math.round(s * 10) / 10, etaSeconds: s === null || analyseWaiting === 0 ? null : Math.round(s * analyseWaiting),
        oldestWaitingSeconds: c!.oldest, perKind: kinds,
      };
    });
  }

  async setPaused(userId: string, queue: (typeof QUEUES)[number], paused: boolean): Promise<void> {
    await withUser(this.sql, userId, (tx) => tx`INSERT INTO queue_controls (user_id, queue, paused) VALUES (${userId}, ${queue}, ${paused})
      ON CONFLICT (user_id, queue) DO UPDATE SET paused = excluded.paused, updated_at = now()`);
  }

  /** Cancels jobs that have not started. A running job is left to finish. Returns how many were cancelled. */
  async cancelWaiting(userId: string): Promise<number> {
    return withUser(this.sql, userId, async (tx) => (await tx`UPDATE jobs SET state = 'CANCELLED', finished_at = now(), locked_by = NULL, locked_until = NULL, last_error = 'cancelled by the owner'
      WHERE state = 'QUEUED' AND kind = ANY (${AI_KINDS as unknown as string[]})`).count);
  }

  /** Moves waiting jobs for chosen photographs (or everything imported within N hours) to the front; `reset` puts every waiting job back to normal. */
  async prioritize(userId: string, p: z.infer<typeof PrioritizeSchema>): Promise<number> {
    return withUser(this.sql, userId, async (tx) => {
      if ('reset' in p) return (await tx`UPDATE jobs SET priority = 0 WHERE state = 'QUEUED' AND priority > 0 AND kind = ANY (${AI_KINDS as unknown as string[]})`).count;
      if ('photoIds' in p) return (await tx`UPDATE jobs SET priority = ${BOOST} WHERE state = 'QUEUED' AND kind = ANY (${AI_KINDS as unknown as string[]}) AND payload ->> 'versionId' IN (
          SELECT v.id::text FROM photo_versions v WHERE v.photo_id = ANY (${p.photoIds}::uuid[]))`).count;
      return (await tx`UPDATE jobs SET priority = ${BOOST} WHERE state = 'QUEUED' AND kind = ANY (${AI_KINDS as unknown as string[]}) AND payload ->> 'versionId' IN (
          SELECT v.id::text FROM photo_versions v WHERE v.ingested_at > now() - make_interval(hours => ${p.importedWithinHours}))`).count;
    });
  }

  async history(userId: string, limit = 30): Promise<HistoryRow[]> {
    const rows = await withUser(this.sql, userId, (tx) => tx<{ id: string; kind: string; outcome: string | null; started_at: Date; secs: number | null; error: string | null; photo_id: string | null; title: string | null }[]>`
      SELECT a.id, j.kind, a.outcome, a.started_at, extract(epoch FROM a.finished_at - a.started_at)::float AS secs, left(a.error, 300) AS error, p.id AS photo_id, p.title
        FROM job_attempts a JOIN jobs j ON j.id = a.job_id
        LEFT JOIN photo_versions v ON v.id::text = j.payload ->> 'versionId' LEFT JOIN photos p ON p.id = v.photo_id
       WHERE j.kind = ANY (${AI_KINDS as unknown as string[]}) ORDER BY a.started_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`);
    return rows.map((r) => ({ id: r.id, kind: r.kind, outcome: r.outcome, startedAt: r.started_at.toISOString(), seconds: r.secs === null ? null : Math.round(r.secs * 10) / 10, error: r.error, photoId: r.photo_id, title: r.title }));
  }
}
