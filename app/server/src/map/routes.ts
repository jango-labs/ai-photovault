import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ClusterSchema, SummarySchema, type MapService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
export interface MapRouteDeps { service: MapService; requireAuth: Guard; fail: Fail }

export function registerMapRoutes(app: FastifyInstance, d: MapRouteDeps): void {
  const { service, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  app.get('/api/map/clusters', { preHandler: requireAuth }, async (req, reply) => {
    const q = ClusterSchema.safeParse(req.query); if (!q.success) return bad(reply);
    return service.clusters(req.session!.userId, q.data);
  });
  app.get('/api/map/summary', { preHandler: requireAuth }, async (req, reply) => {
    const q = SummarySchema.safeParse(req.query); if (!q.success) return bad(reply);
    return service.summary(req.session!.userId, q.data);
  });
}
