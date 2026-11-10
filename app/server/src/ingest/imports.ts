import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { withUser } from '../db/connect.js';

/** Read models and review decisions for the Imports workspace. Starting a scan is IngestService's job (and needs approval). */
export interface RunRow { id: string; mode: 'DRY_RUN' | 'APPLY'; state: string; sourcePath: string; startedAt: string; finishedAt: string | null; heartbeatAt: string; counters: Record<string, unknown>; error: string | null; resumedFrom: string | null }
const mapRun = (r: { id: string; mode: 'DRY_RUN' | 'APPLY'; state: string; source_path: string; started_at: Date; finished_at: Date | null; heartbeat_at: Date; counters: Record<string, unknown>; error: string | null; resumed_from: string | null }): RunRow => ({
  id: r.id, mode: r.mode, state: r.state, sourcePath: r.source_path, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, heartbeatAt: r.heartbeat_at.toISOString(), counters: r.counters, error: r.error, resumedFrom: r.resumed_from,
});

export class ImportsService {
  constructor(private readonly sql: Sql) {}

  runs(userId: string, limit = 30): Promise<RunRow[]> {
    return withUser(this.sql, userId, async (tx) => (await tx<Parameters<typeof mapRun>[0][]>`SELECT id, mode, state, source_path, started_at, finished_at, heartbeat_at, counters, error, resumed_from FROM import_runs ORDER BY started_at DESC LIMIT ${limit}`).map(mapRun));
  }

  async run(userId: string, id: string, o: { action?: string; limit: number; after?: number }) {
    return withUser(this.sql, userId, async (tx) => {
      const [r] = await tx<Parameters<typeof mapRun>[0][]>`SELECT id, mode, state, source_path, started_at, finished_at, heartbeat_at, counters, error, resumed_from FROM import_runs WHERE id = ${id}::uuid`;
      if (!r) return null;
      const items = await tx<Array<{ id: string; relpath: string; action: string; detail: string | null; sha: string | null }>>`
        SELECT id, relpath, action, detail, encode(substring(sha256 from 1 for 6), 'hex') AS sha FROM import_items
         WHERE run_id = ${id}::uuid ${o.action ? tx`AND action = ${o.action}` : tx``} ${o.after ? tx`AND id > ${o.after}` : tx``} ORDER BY id LIMIT ${o.limit + 1}`;
      const page = items.slice(0, o.limit);
      const byAction = await tx<{ action: string; n: number }[]>`SELECT action, count(*)::int AS n FROM import_items WHERE run_id = ${id}::uuid GROUP BY action`;
      return { run: mapRun(r), items: page, nextAfter: items.length > o.limit ? page[page.length - 1]!.id : null, byAction: Object.fromEntries(byAction.map((b) => [b.action, b.n])) };
    });
  }

  /** Queue and derivative health for the "Processing" panel. */
  async queue(userId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const jobs = await tx<{ kind: string; state: string; n: number }[]>`SELECT kind, state, count(*)::int AS n FROM jobs WHERE kind LIKE 'derive.%' OR kind LIKE 'ai.%' GROUP BY kind, state ORDER BY kind, state`;
      const [d] = await tx<{ pending: number; ready: number; failed: number; missing: number }[]>`
        SELECT count(*) FILTER (WHERE deriv_status = 'PENDING')::int AS pending, count(*) FILTER (WHERE deriv_status = 'READY')::int AS ready, count(*) FILTER (WHERE deriv_status = 'FAILED')::int AS failed, count(*) FILTER (WHERE NOT source_present)::int AS missing FROM photo_versions`;
      const failed = await tx<{ id: string; kind: string; state: string; last_error: string | null; attempts: number; relpath: string | null }[]>`
        SELECT j.id, j.kind, j.state, j.last_error, j.attempts, v.source_relpath AS relpath FROM jobs j LEFT JOIN photo_versions v ON v.id = (j.payload ->> 'versionId')::uuid
         WHERE j.state IN ('FAILED','DEAD') ORDER BY j.finished_at DESC NULLS LAST LIMIT 20`;
      const [hb] = await tx<{ at: Date }[]>`SELECT at FROM service_heartbeats WHERE service = 'worker' ORDER BY at DESC LIMIT 1`.catch(() => [] as { at: Date }[]);
      return { jobs, derivatives: d!, failed: failed.map((f) => ({ id: f.id, kind: f.kind, state: f.state, error: f.last_error, attempts: f.attempts, relpath: f.relpath })), workerSeenAt: hb?.at.toISOString() ?? null };
    });
  }

  retryFailed(userId: string, kind = 'derive.preview'): Promise<number> {
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx`UPDATE jobs SET state = 'QUEUED', attempts = 0, run_after = now(), last_error = NULL, finished_at = NULL WHERE kind = ${kind} AND state IN ('FAILED','DEAD') RETURNING payload`;
      for (const r of rows) await tx`UPDATE photo_versions SET deriv_status = 'PENDING' WHERE id = ${String((r.payload as { versionId?: string }).versionId)}::uuid AND deriv_status = 'FAILED'`;
      return rows.length;
    });
  }

  // ------------------------------------------------------------------------------------------------ review queue
  async review(userId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const rows = await tx<Array<{ id: string; kind: string; subject: Record<string, string>; created_at: Date }>>`SELECT id, kind, subject, created_at FROM review_queue WHERE state = 'OPEN' AND kind IN ('VERSION_MATCH','DUPLICATE_FILE') ORDER BY created_at LIMIT 100`;
      return rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, createdAt: r.created_at.toISOString() }));
    });
  }

  /**
   * VERSION_MATCH: SAME_PHOTO → the pending file becomes the current version of the existing photograph (earlier one SUPERSEDED);
   *                DIFFERENT_PHOTO → it becomes its own photograph. DUPLICATE_FILE: ACKNOWLEDGE. Always reversible by hand; nothing is deleted.
   */
  async decide(userId: string, id: string, decision: 'SAME_PHOTO' | 'DIFFERENT_PHOTO' | 'ACKNOWLEDGE' | 'SKIP'): Promise<'ok' | 'not_found' | 'invalid'> {
    return withUser(this.sql, userId, async (tx) => {
      const [q] = await tx<{ kind: string; subject: Record<string, string> }[]>`SELECT kind, subject FROM review_queue WHERE id = ${id}::uuid AND state = 'OPEN' FOR UPDATE`;
      if (!q) return 'not_found' as const;
      if (decision === 'SKIP') { await tx`UPDATE review_queue SET state = 'SKIPPED' WHERE id = ${id}::uuid`; return 'ok' as const; }
      if (q.kind === 'DUPLICATE_FILE') { if (decision !== 'ACKNOWLEDGE') return 'invalid' as const; await tx`UPDATE review_queue SET state = 'CONFIRMED', decided_at = now() WHERE id = ${id}::uuid`; return 'ok' as const; }
      if (q.kind !== 'VERSION_MATCH' || (decision !== 'SAME_PHOTO' && decision !== 'DIFFERENT_PHOTO')) return 'invalid' as const;
      const { photoId, versionId } = q.subject as { photoId: string; versionId: string };
      const [v] = await tx<{ id: string; state: string }[]>`SELECT id, state FROM photo_versions WHERE id = ${versionId}::uuid AND photo_id = ${photoId}::uuid FOR UPDATE`;
      if (!v || v.state !== 'PENDING_REVIEW') { await tx`UPDATE review_queue SET state = 'SKIPPED' WHERE id = ${id}::uuid`; return 'ok' as const; }
      if (decision === 'SAME_PHOTO') {
        await tx`UPDATE photo_versions SET state = 'SUPERSEDED' WHERE photo_id = ${photoId}::uuid AND state = 'ACTIVE'`;
        await tx`UPDATE photo_versions SET state = 'ACTIVE' WHERE id = ${versionId}::uuid`;
        await tx`UPDATE photos SET current_version_id = ${versionId}::uuid WHERE id = ${photoId}::uuid`;
        await tx`INSERT INTO photo_edits (user_id, photo_id, field, old_value, new_value, kind) SELECT ${userId}, ${photoId}::uuid, 'current_version', '{}'::jsonb, ${tx.json({ versionId } as never)}, 'EDIT'`;
      } else {
        const np = randomUUID();
        await tx`INSERT INTO photos (id, user_id, current_version_id, year, year_source, trip_location, trip_location_source, subpath)
                 SELECT ${np}::uuid, ${userId}, ${versionId}::uuid, p.year, p.year_source, p.trip_location, p.trip_location_source, p.subpath FROM photos p WHERE p.id = ${photoId}::uuid`;
        await tx`UPDATE photo_versions SET photo_id = ${np}::uuid, version_no = 1, state = 'ACTIVE' WHERE id = ${versionId}::uuid`;
      }
      await tx`UPDATE review_queue SET state = ${decision === 'SAME_PHOTO' ? 'CONFIRMED' : 'REJECTED'}, decided_at = now() WHERE id = ${id}::uuid`;
      return 'ok' as const;
    });
  }
}
