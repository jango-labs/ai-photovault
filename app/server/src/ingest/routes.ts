import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertApproved, NotApprovedError, loadPolicy, type IngestMode } from './approval.js';
import { ImportsService } from './imports.js';
import path from 'node:path';
import { IngestService } from './service.js';
import { sourceInfo, type SourceConfig } from './source.js';
import type { Sql } from 'postgres';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
const Uuid = z.string().uuid();

export interface ImportRouteDeps { sql: Sql; requireAuth: Guard; fail: Fail; stateDir: string; ingestDir: string | null; derivativesDir: string | null; source?: SourceConfig | null }

/**
 * Imports workspace API. A scan can only be started for the configured source directory, only after the owner approved that
 * directory (approvals file), and only one at a time. Without approval every start request is refused — including a dry run.
 */
export function registerImportRoutes(app: FastifyInstance, d: ImportRouteDeps): void {
  const { requireAuth, fail } = d;
  const imports = new ImportsService(d.sql);
  const running = new Map<string, AbortController>();
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const approval = (mode: IngestMode) => { if (!d.ingestDir) return false; try { assertApproved(loadPolicy(d.stateDir), d.ingestDir, mode); return true; } catch { return false; } };

  app.get('/api/imports/status', { preHandler: requireAuth }, async (req) => {
    const u = req.session!.userId;
    const ingest = new IngestService({ sql: d.sql, policy: loadPolicy(d.stateDir) }); await ingest.recover(u);
    const [queue, runs] = await Promise.all([imports.queue(u), imports.runs(u, 1)]);
    const cfg = d.source ?? (d.ingestDir ? { name: path.basename(d.ingestDir), dir: d.ingestDir, intervalMin: 0 } : null);
    const info = cfg ? await sourceInfo(d.sql, u, cfg).catch(() => null) : null;
    return { source: { configured: d.ingestDir, dryRunApproved: approval('DRY_RUN'), applyApproved: approval('APPLY'), previewsDirectory: d.derivativesDir !== null, info }, running: [...running.keys()].length > 0, queue, lastRun: runs[0] ?? null };
  });

  app.get('/api/imports/runs', { preHandler: requireAuth }, async (req) => ({ runs: await imports.runs(req.session!.userId) }));

  app.get('/api/imports/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id);
    const q = z.object({ action: z.enum(['NEW', 'NEW_VERSION', 'MOVED', 'DUPLICATE_FILE', 'VERSION_REVIEW', 'SOURCE_MISSING', 'SKIPPED', 'ERROR']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), after: z.coerce.number().int().min(0).optional() }).strict().safeParse(req.query);
    if (!id.success || !q.success) return bad(reply);
    const r = await imports.run(req.session!.userId, id.data, q.data);
    return r ?? fail(reply, 404, 'not_found', 'No such import run.');
  });

  app.post('/api/imports/runs', { preHandler: requireAuth }, async (req, reply) => {
    const b = z.object({ mode: z.enum(['DRY_RUN', 'APPLY']) }).strict().safeParse(req.body); if (!b.success) return bad(reply);
    if (!d.ingestDir) return fail(reply, 409, 'no_source', 'No source directory is configured (PHOTOVAULT_INGEST_DIR).');
    if (running.size > 0) return fail(reply, 409, 'already_running', 'An import is already running.');
    const u = req.session!.userId;
    // the worker's scheduled scan runs in another process: a fresh heartbeat in the database means a run is active
    if ((await d.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM import_runs WHERE state = 'RUNNING' AND heartbeat_at > now() - interval '120 seconds' AND user_id = ${u}`)[0]!.n > 0) return fail(reply, 409, 'already_running', 'An import is already running.');
    const ingest = new IngestService({ sql: d.sql, policy: loadPolicy(d.stateDir), derivativesDir: d.derivativesDir });
    try {
      const { runId, done } = await ingest.start(u, d.ingestDir, b.data.mode, (() => { const ac = new AbortController(); running.set('pending', ac); return ac.signal; })());
      const ac = running.get('pending')!; running.delete('pending'); running.set(runId, ac);
      void done.finally(() => running.delete(runId));
      return reply.code(202).send({ runId });
    } catch (e) {
      running.delete('pending');
      if (e instanceof NotApprovedError) return fail(reply, 403, 'not_approved', 'The owner has not approved this directory yet. Nothing was scanned.');
      return fail(reply, 422, 'refused', e instanceof Error ? e.message.slice(0, 200) : 'The directory was refused.');
    }
  });

  app.post('/api/imports/runs/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); if (!id.success) return bad(reply);
    const ac = running.get(id.data); if (!ac) return fail(reply, 404, 'not_running', 'That run is not running in this process.');
    ac.abort(); return { ok: true };
  });

  app.post('/api/imports/jobs/retry', { preHandler: requireAuth }, async (req) => ({ requeued: await imports.retryFailed(req.session!.userId) }));
  app.get('/api/imports/review', { preHandler: requireAuth }, async (req) => ({ items: await imports.review(req.session!.userId) }));
  app.post('/api/imports/review/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); const b = z.object({ decision: z.enum(['SAME_PHOTO', 'DIFFERENT_PHOTO', 'ACKNOWLEDGE', 'SKIP']) }).strict().safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    const r = await imports.decide(req.session!.userId, id.data, b.data.decision);
    return r === 'ok' ? { ok: true } : r === 'not_found' ? fail(reply, 404, 'not_found', 'Nothing to decide.') : fail(reply, 400, 'invalid_request', 'That decision does not apply.');
  });
}
