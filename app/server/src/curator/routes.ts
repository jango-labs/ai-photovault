import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DraftSchema, FeedbackSchema, RunSchema, type CuratorService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
export interface CuratorRouteDeps { service: CuratorService; requireAuth: Guard; fail: Fail }
const Uuid = z.string().uuid();

export function registerCuratorRoutes(app: FastifyInstance, d: CuratorRouteDeps): void {
  const { service, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const uid = (req: FastifyRequest) => req.session!.userId;
  const idOf = (req: FastifyRequest) => Uuid.safeParse((req.params as { id: string }).id);

  app.post('/api/curator/run', { preHandler: requireAuth }, async (req, reply) => {
    const b = RunSchema.safeParse(req.body ?? {}); if (!b.success) return bad(reply);
    return service.run(uid(req), b.data);
  });
  app.get('/api/curator/runs', { preHandler: requireAuth }, async (req) => ({ items: await service.runs(uid(req)) }));
  app.get('/api/curator/runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); if (!id.success) return bad(reply);
    return (await service.getRun(uid(req), id.data)) ?? fail(reply, 404, 'not_found', 'No such run.');
  });
  app.post('/api/curator/runs/:id/draft', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); const b = DraftSchema.safeParse(req.body ?? {}); if (!id.success || !b.success) return bad(reply);
    const r = await service.draft(uid(req), id.data, b.data);
    return r.ok ? reply.code(201).send(r.value) : fail(reply, r.code === 'not_found' ? 404 : 400, r.code, r.message);
  });
  app.post('/api/curator/feedback', { preHandler: requireAuth }, async (req, reply) => {
    const b = FeedbackSchema.safeParse(req.body); if (!b.success) return bad(reply);
    const r = await service.feedback(uid(req), b.data);
    return r.ok ? { ok: true } : fail(reply, 404, r.code, r.message);
  });
  app.get('/api/curator/feedback', { preHandler: requireAuth }, async (req) => service.currentFeedback(uid(req)));
  app.get('/api/curator/themes', { preHandler: requireAuth }, async (req) => ({ items: await service.themes(uid(req)) }));
}
