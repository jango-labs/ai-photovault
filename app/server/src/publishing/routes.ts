import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApproveSchema, CalendarSchema, CreateSchema, ListSchema, PatchSchema, ReschedSchema, ScheduleSchema, type Out, type PublishingService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
export interface PublishingRouteDeps { service: PublishingService; requireAuth: Guard; fail: Fail }
const Uuid = z.string().uuid();
const STATUS = { not_found: 404, invalid: 400, conflict: 409, history: 409, limit: 409 } as const;

export function registerPublishingRoutes(app: FastifyInstance, d: PublishingRouteDeps): void {
  const { service, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const uid = (req: FastifyRequest) => req.session!.userId;
  const id = (req: FastifyRequest) => Uuid.safeParse((req.params as { id: string }).id);
  const send = <T>(reply: FastifyReply, r: Out<T>, code = 200) => (r.ok ? reply.code(code).send(r.value) : fail(reply, STATUS[r.code], r.code, r.message, r.extra));
  const P = '/api/publishing';

  app.get(`${P}/drafts`, { preHandler: requireAuth }, async (req, reply) => { const q = ListSchema.safeParse(req.query); return q.success ? send(reply, await service.list(uid(req), q.data)) : bad(reply); });
  app.post(`${P}/drafts`, { preHandler: requireAuth }, async (req, reply) => { const b = CreateSchema.safeParse(req.body); return b.success ? send(reply, await service.create(uid(req), b.data), 201) : bad(reply); });
  app.get(`${P}/drafts/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const i = id(req); if (!i.success) return bad(reply);
    const dr = await service.get(uid(req), i.data); return dr ? { ...dr, captionVersions: await service.versions(uid(req), i.data) } : fail(reply, 404, 'not_found', 'No such draft.');
  });
  app.get(`${P}/drafts/:id/attempts`, { preHandler: requireAuth }, async (req, reply) => { const i = id(req); return i.success ? { items: await service.attempts(uid(req), i.data) } : bad(reply); });
  app.patch(`${P}/drafts/:id`, { preHandler: requireAuth }, async (req, reply) => { const i = id(req); const b = PatchSchema.safeParse(req.body); return i.success && b.success ? send(reply, await service.update(uid(req), i.data, b.data)) : bad(reply); });
  const act = (name: string, run: (u: string, i: string, body: unknown) => Promise<Out<unknown>>, schema?: z.ZodTypeAny) =>
    app.post(`${P}/drafts/:id/${name}`, { preHandler: requireAuth }, async (req, reply) => {
      const i = id(req); const b = schema ? schema.safeParse(req.body ?? {}) : { success: true as const, data: undefined }; if (!i.success || !b.success) return bad(reply);
      return send(reply, await run(uid(req), i.data, b.data));
    });
  act('ready', (u, i) => service.markReady(u, i)); act('unready', (u, i) => service.unready(u, i)); act('cancel', (u, i) => service.cancelDraft(u, i)); act('reopen', (u, i) => service.reopen(u, i));
  act('approve', (u, i, b) => service.approve(u, i, b as z.infer<typeof ApproveSchema>), ApproveSchema); act('schedule', (u, i, b) => service.schedule(u, i, b as z.infer<typeof ScheduleSchema>), ScheduleSchema);
  app.patch(`${P}/schedule/:id`, { preHandler: requireAuth }, async (req, reply) => { const i = id(req); const b = ReschedSchema.safeParse(req.body); return i.success && b.success ? send(reply, await service.reschedule(uid(req), i.data, b.data)) : bad(reply); });
  app.post(`${P}/schedule/:id/cancel`, { preHandler: requireAuth }, async (req, reply) => { const i = id(req); return i.success ? send(reply, await service.cancelSchedule(uid(req), i.data)) : bad(reply); });
  app.get(`${P}/calendar`, { preHandler: requireAuth }, async (req, reply) => { const q = CalendarSchema.safeParse(req.query); return q.success ? send(reply, await service.calendar(uid(req), q.data.from, q.data.to)) : bad(reply); });
  app.post(`${P}/captions/suggest`, { preHandler: requireAuth }, async (req, reply) => {
    const b = z.object({ photoId: Uuid, engine: z.enum(['template', 'ollama']).default('template') }).strict().safeParse(req.body); if (!b.success) return bad(reply);
    if (b.data.engine === 'ollama') { const r = await service.suggestWithModel(uid(req), b.data.photoId); return r.ok ? r.value : fail(reply, r.reason === 'not_found' ? 404 : 503, r.reason === 'not_found' ? 'not_found' : 'model_unavailable', r.message); }
    return (await service.suggestCaptions(uid(req), b.data.photoId)) ?? fail(reply, 404, 'not_found', 'No such photograph.');
  });
  app.get(`${P}/hashtags/suggest`, { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ photoId: Uuid }).strict().safeParse(req.query); if (!q.success) return bad(reply);
    return (await service.suggestHashtags(uid(req), q.data.photoId)) ?? fail(reply, 404, 'not_found', 'No such photograph.');
  });
}
