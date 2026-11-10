import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SearchSchema, type SearchService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
export interface SearchRouteDeps { service: SearchService; requireAuth: Guard; fail: Fail }

const Uuid = z.string().uuid();
const SaveSchema = z.object({ name: z.string().trim().min(1).max(80), q: z.string().trim().min(1).max(300), exclude: z.array(z.string().max(160)).max(30).default([]) }).strict();

export function registerSearchRoutes(app: FastifyInstance, d: SearchRouteDeps): void {
  const { service, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const uid = (req: FastifyRequest) => req.session!.userId;

  app.get('/api/search', { preHandler: requireAuth }, async (req, reply) => {
    const q = SearchSchema.safeParse(req.query); if (!q.success) return bad(reply);
    return service.search(uid(req), q.data);
  });
  app.get('/api/search/similar/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); if (!id.success) return bad(reply);
    const limit = z.coerce.number().int().min(1).max(60).default(24).safeParse((req.query as { limit?: string }).limit); if (!limit.success) return bad(reply);
    const r = await service.similar(uid(req), id.data, limit.data);
    if ('missing' in r) return r.missing === 'photo' ? fail(reply, 404, 'not_found', 'No such photograph.') : fail(reply, 409, 'not_embedded', 'This photograph has not been indexed for similarity yet. Run Reindex in Settings → AI.');
    return r;
  });
  app.get('/api/search/history', { preHandler: requireAuth }, async (req) => ({ items: await service.history(uid(req)) }));
  app.delete('/api/search/history', { preHandler: requireAuth }, async (req) => ({ removed: await service.clearHistory(uid(req)) }));
  app.delete('/api/search/history/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); if (!id.success) return bad(reply);
    return (await service.clearHistory(uid(req), id.data)) ? { ok: true } : fail(reply, 404, 'not_found', 'No such entry.');
  });
  app.get('/api/search/saved', { preHandler: requireAuth }, async (req) => ({ items: await service.saved(uid(req)) }));
  app.post('/api/search/saved', { preHandler: requireAuth }, async (req, reply) => {
    const b = SaveSchema.safeParse(req.body); if (!b.success) return bad(reply);
    const r = await service.save(uid(req), b.data.name, b.data.q, b.data.exclude);
    return 'duplicate' in r ? fail(reply, 409, 'name_in_use', 'A saved search or collection with that name already exists.') : reply.code(201).send(r);
  });
  app.delete('/api/search/saved/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); if (!id.success) return bad(reply);
    return (await service.deleteSaved(uid(req), id.data)) ? { ok: true } : fail(reply, 404, 'not_found', 'No such saved search.');
  });
  app.get('/api/search/discover', { preHandler: requireAuth }, async (req) => service.discover(uid(req)));
  app.get('/api/search/status', { preHandler: requireAuth }, async (req) => service.status(uid(req)));
  app.post('/api/search/reindex', { preHandler: requireAuth }, async (req) => service.reindex(uid(req)));
}
