import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AiQueue, PrioritizeSchema, QueueSchema } from './queue.js';
import { AiService, AnalyzeSchema, SettingsSchema } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
const Uuid = z.string().uuid();

/** AI analysis API. Everything here is advisory: it records suggestions and your decisions about them; nothing changes a file or publishes anything. */
export function registerAiRoutes(app: FastifyInstance, d: { ai: AiService; queue: AiQueue; requireAuth: Guard; fail: Fail }): void {
  const { ai, queue, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const nf = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'No such photograph.');
  const idp = (req: FastifyRequest, k = 'id') => Uuid.safeParse((req.params as Record<string, string>)[k]);

  // ---- processing queue: progress, pause / resume, cancel what has not started, prioritise, history
  app.get('/api/ai/queue', { preHandler: requireAuth }, async (req) => queue.status(req.session!.userId));
  app.get('/api/ai/queue/history', { preHandler: requireAuth }, async (req) => ({ items: await queue.history(req.session!.userId, Number((req.query as { limit?: string }).limit) || 30) }));
  app.post('/api/ai/queue/pause', { preHandler: requireAuth }, async (req, reply) => { const b = QueueSchema.safeParse(req.body ?? {}); if (!b.success) return bad(reply); await queue.setPaused(req.session!.userId, b.data.queue, true); return queue.status(req.session!.userId); });
  app.post('/api/ai/queue/resume', { preHandler: requireAuth }, async (req, reply) => { const b = QueueSchema.safeParse(req.body ?? {}); if (!b.success) return bad(reply); await queue.setPaused(req.session!.userId, b.data.queue, false); return queue.status(req.session!.userId); });
  app.post('/api/ai/queue/cancel', { preHandler: requireAuth }, async (req) => ({ cancelled: await queue.cancelWaiting(req.session!.userId) }));
  app.post('/api/ai/queue/prioritize', { preHandler: requireAuth }, async (req, reply) => { const b = PrioritizeSchema.safeParse(req.body); return b.success ? { updated: await queue.prioritize(req.session!.userId, b.data) } : bad(reply); });

  app.get('/api/ai/status', { preHandler: requireAuth }, async (req) => ai.status(req.session!.userId));
  app.put('/api/ai/settings', { preHandler: requireAuth }, async (req, reply) => {
    const b = SettingsSchema.safeParse(req.body); if (!b.success) return bad(reply);
    if (b.data.provider === 'ollama') { const why = await ai.ollamaBlocker(); if (why) return fail(reply, 409, 'provider_unavailable', `The local vision model cannot be selected: ${why}.`); }
    return ai.setSettings(req.session!.userId, b.data);
  });

  app.post('/api/ai/analyze', { preHandler: requireAuth }, async (req, reply) => { const b = AnalyzeSchema.safeParse(req.body); return b.success ? ai.enqueue(req.session!.userId, b.data.target, b.data.force) : bad(reply); });

  app.get('/api/ai/photos/:id', { preHandler: requireAuth }, async (req, reply) => { const id = idp(req); if (!id.success) return bad(reply); return (await ai.photo(req.session!.userId, id.data)) ?? nf(reply); });
  app.post('/api/ai/photos/:id/analyze', { preHandler: requireAuth }, async (req, reply) => {
    const id = idp(req); const b = z.object({ force: z.boolean().default(true) }).strict().safeParse(req.body ?? {}); if (!id.success || !b.success) return bad(reply);
    if (!(await ai.photo(req.session!.userId, id.data))) return nf(reply);
    return ai.enqueue(req.session!.userId, { ids: [id.data] }, b.data.force);
  });
  app.post('/api/ai/photos/:id/species/:linkId', { preHandler: requireAuth }, async (req, reply) => {
    const id = idp(req); const link = idp(req, 'linkId'); const b = z.object({ action: z.enum(['confirm', 'reject']) }).strict().safeParse(req.body);
    if (!id.success || !link.success || !b.success) return bad(reply);
    return (await ai.decideSpecies(req.session!.userId, id.data, link.data, b.data.action)) ? { ok: true } : nf(reply);
  });
  app.post('/api/ai/photos/:id/species', { preHandler: requireAuth }, async (req, reply) => {
    const id = idp(req);
    const b = z.object({ commonName: z.string().trim().min(1).max(120), scientificName: z.string().trim().max(160).nullable().optional(), replaces: Uuid.optional() }).strict().safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    return (await ai.addSpecies(req.session!.userId, id.data, b.data)) ? { ok: true } : nf(reply);
  });
  app.post('/api/ai/photos/:id/accept-description', { preHandler: requireAuth }, async (req, reply) => {
    const id = idp(req); const b = z.object({ analysisId: Uuid }).strict().safeParse(req.body); if (!id.success || !b.success) return bad(reply);
    return (await ai.acceptDescription(req.session!.userId, id.data, b.data.analysisId)) ? { ok: true } : nf(reply);
  });
}
