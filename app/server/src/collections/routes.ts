import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateSchema, MoveSchema, PatchSchema, TargetSchema, type CollectionService, type Outcome } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
export interface CollectionRouteDeps { service: CollectionService; requireAuth: Guard; fail: Fail }

const Uuid = z.string().uuid();
const StatusSchema = z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).default('ACTIVE');
const PageSchema = z.object({ cursor: z.string().max(600).optional(), limit: z.coerce.number().int().min(1).max(200).default(120) }).strict();
const RemoveSchema = z.object({ ids: z.array(Uuid).min(1).max(500) }).strict();
const STATUS = { not_found: 404, conflict: 409, invalid: 400, name_in_use: 409 } as const;

export function registerCollectionRoutes(app: FastifyInstance, d: CollectionRouteDeps): void {
  const { service, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const uid = (req: FastifyRequest) => req.session!.userId;
  const idOf = (req: FastifyRequest) => Uuid.safeParse((req.params as { id: string }).id);
  const send = <T>(reply: FastifyReply, r: Outcome<T>, code = 200): unknown => (r.ok ? reply.code(code).send(r.value ?? { ok: true }) : fail(reply, STATUS[r.code], r.code, r.message));

  app.get('/api/collections', { preHandler: requireAuth }, async (req, reply) => {
    const s = StatusSchema.safeParse((req.query as { status?: string }).status); if (!s.success) return bad(reply);
    return { items: await service.list(uid(req), s.data) };
  });
  app.post('/api/collections', { preHandler: requireAuth }, async (req, reply) => {
    const b = CreateSchema.safeParse(req.body); if (!b.success) return bad(reply);
    return send(reply, await service.create(uid(req), b.data), 201);
  });
  app.get('/api/collections/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); if (!id.success) return bad(reply);
    return (await service.get(uid(req), id.data)) ?? fail(reply, 404, 'not_found', 'No such collection.');
  });
  app.patch('/api/collections/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); const b = PatchSchema.safeParse(req.body); if (!id.success || !b.success) return bad(reply);
    return send(reply, await service.update(uid(req), id.data, b.data));
  });
  app.delete('/api/collections/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); if (!id.success) return bad(reply);
    return (await service.remove(uid(req), id.data)) ? { ok: true } : fail(reply, 404, 'not_found', 'No such collection.');
  });
  app.post('/api/collections/:id/activate', { preHandler: requireAuth }, async (req, reply) => { const id = idOf(req); if (!id.success) return bad(reply); return send(reply, await service.setState(uid(req), id.data, 'activate')); });
  app.post('/api/collections/:id/archive', { preHandler: requireAuth }, async (req, reply) => { const id = idOf(req); if (!id.success) return bad(reply); return send(reply, await service.setState(uid(req), id.data, 'archive')); });

  app.get('/api/collections/:id/photos', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); const p = PageSchema.safeParse(req.query); if (!id.success || !p.success) return bad(reply);
    return send(reply, await service.photos(uid(req), id.data, p.data.cursor, p.data.limit));
  });
  app.post('/api/collections/:id/photos', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); const b = z.object({ target: TargetSchema }).strict().safeParse(req.body); if (!id.success || !b.success) return bad(reply);
    return send(reply, await service.add(uid(req), id.data, b.data.target));
  });
  app.delete('/api/collections/:id/photos', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); const b = RemoveSchema.safeParse(req.body); if (!id.success || !b.success) return bad(reply);
    return send(reply, await service.removeMembers(uid(req), id.data, b.data.ids));
  });
  app.post('/api/collections/:id/move', { preHandler: requireAuth }, async (req, reply) => {
    const id = idOf(req); const b = MoveSchema.safeParse(req.body); if (!id.success || !b.success) return bad(reply);
    return send(reply, await service.move(uid(req), id.data, b.data));
  });
}
