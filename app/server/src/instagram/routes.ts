import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InstagramConnection } from './oauth.js';
import { IgOAuthError } from './oauth.js';
import { DecideSchema, HistorySchema, LinkSchema, PostedCheckSchema, ReviewSchema, SyntheticSchema, type InstagramService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
export interface InstagramRouteDeps { service: InstagramService; requireAuth: Guard; fail: Fail; connection?: InstagramConnection }
const Uuid = z.string().uuid();
const CODE = { not_found: 404, unavailable: 403, invalid: 400, conflict: 409 } as const;
type Result = { ok: true; value: unknown } | { ok: false; code: keyof typeof CODE; message: string };

export function registerInstagramRoutes(app: FastifyInstance, d: InstagramRouteDeps): void {
  const { service, requireAuth, fail } = d;
  if (d.connection) registerConnectionRoutes(app, { connection: d.connection, requireAuth, fail });
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const uid = (req: FastifyRequest) => req.session!.userId;
  const id = (req: FastifyRequest) => Uuid.safeParse((req.params as { id: string }).id);
  const out = (reply: FastifyReply, r: Result, status = 200) => (r.ok ? reply.code(status).send(r.value ?? { ok: true }) : fail(reply, CODE[r.code], r.code, r.message));
  const asResult = (r: unknown): Result => r as Result;

  app.get('/api/instagram/account', { preHandler: requireAuth }, async (req) => service.account(uid(req)));
  app.post('/api/instagram/synthetic', { preHandler: requireAuth }, async (req, reply) => {
    const b = SyntheticSchema.safeParse(req.body ?? {}); if (!b.success) return bad(reply);
    return out(reply, asResult(await service.createSynthetic(uid(req), b.data.count)), 201);
  });
  app.post('/api/instagram/sync', { preHandler: requireAuth }, async (req, reply) => ((await service.enqueueSync(uid(req))) ? { queued: true } : fail(reply, 404, 'no_account', 'There is no Instagram account yet.')));
  app.post('/api/instagram/rematch', { preHandler: requireAuth }, async (req) => { await service.rematch(uid(req)); return { queued: true }; });
  app.get('/api/instagram/history', { preHandler: requireAuth }, async (req, reply) => {
    const q = HistorySchema.safeParse(req.query); if (!q.success) return bad(reply);
    const r = await service.history(uid(req), q.data); return 'ok' in r ? out(reply, asResult(r)) : r;
  });
  app.get('/api/instagram/review', { preHandler: requireAuth }, async (req, reply) => { const q = ReviewSchema.safeParse(req.query); return q.success ? service.review(uid(req), q.data.limit) : bad(reply); });
  app.post('/api/instagram/matches/:id', { preHandler: requireAuth }, async (req, reply) => {
    const i = id(req); const b = DecideSchema.safeParse(req.body); if (!i.success || !b.success) return bad(reply);
    return out(reply, asResult(await service.decide(uid(req), i.data, b.data.decision)));
  });
  app.post('/api/instagram/media/:id/link', { preHandler: requireAuth }, async (req, reply) => {
    const i = id(req); const b = LinkSchema.safeParse(req.body); if (!i.success || !b.success) return bad(reply);
    return out(reply, asResult(await service.link(uid(req), i.data, b.data.photoId)));
  });
  app.get('/api/instagram/posted-check', { preHandler: requireAuth }, async (req, reply) => {
    const q = PostedCheckSchema.safeParse(req.query); if (!q.success) return bad(reply);
    const r = await service.postedCheck(uid(req), q.data.photoId); return 'ok' in r ? out(reply, asResult(r)) : r;
  });
  // Instagram images are only ever served to their signed-in owner
  app.get('/api/instagram/media/:id/image', { preHandler: requireAuth }, async (req, reply) => {
    const i = id(req); if (!i.success) return bad(reply);
    const file = await service.mediaFile(uid(req), i.data); if (!file) return fail(reply, 404, 'not_found', 'No such image.');
    reply.header('cache-control', 'private, max-age=3600').header('etag', `"ig-${i.data}"`);
    if (req.headers['if-none-match'] === `"ig-${i.data}"`) return reply.code(304).send();
    return reply.type('image/jpeg').header('content-disposition', 'inline').send(fs.createReadStream(file));
  });
}


/** Connecting an Instagram professional account (OAuth). The callback is a GET that Instagram redirects the signed-in owner's browser to; `state` ties it to this person. */
function registerConnectionRoutes(app: FastifyInstance, d: { connection: InstagramConnection; requireAuth: Guard; fail: Fail }): void {
  const { connection, requireAuth, fail } = d; const uid = (req: FastifyRequest) => req.session!.userId;
  app.get('/api/instagram/connection', { preHandler: requireAuth }, async (req) => connection.status(uid(req)));
  app.post('/api/instagram/connect', { preHandler: requireAuth }, async (req, reply) => {
    try { return connection.begin(uid(req)); }
    catch (e) { return e instanceof IgOAuthError ? fail(reply, 409, e.code, e.code === 'not_configured' ? 'Connecting Instagram needs a Meta developer app and your approval first. Nothing has been sent anywhere.' : e.message) : fail(reply, 500, 'internal', 'Could not start the connection.'); }
  });
  app.get('/api/instagram/oauth/callback', { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(600).optional(), error: z.string().max(100).optional() }).passthrough().safeParse(req.query);
    if (!q.success) return reply.redirect('/publish/history?connection=error&reason=invalid', 302);
    try { await connection.complete(uid(req), { ...(q.data.code ? { code: q.data.code } : {}), ...(q.data.state ? { state: q.data.state } : {}), ...(q.data.error ? { error: q.data.error } : {}) }); return reply.redirect('/publish/history?connection=ok', 302); }
    catch (e) { if (!(e instanceof IgOAuthError)) req.log.error({ msg: e instanceof Error ? e.message : String(e) }, 'instagram connection failed'); return reply.redirect(`/publish/history?connection=error&reason=${e instanceof IgOAuthError ? e.code : 'failed'}`, 302); }
  });
  app.post('/api/instagram/disconnect', { preHandler: requireAuth }, async (req) => ({ disconnected: await connection.disconnect(uid(req)) }));
}
