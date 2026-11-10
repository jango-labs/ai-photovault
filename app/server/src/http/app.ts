import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { RateLimiter } from '../auth/limiter.js';
import { passwordProblem } from '../auth/password.js';
import { AuthService, type ClientCtx } from '../auth/service.js';
import { csrfFor, csrfValid } from '../auth/tokens.js';
import type { AppConfig } from '../config.js';
import { registerLibraryRoutes } from '../library/routes.js';
import { DuplicateService } from '../library/duplicates.js';
import { EditService } from '../library/edit.js';
import { AiService } from '../ai/service.js';
import { OllamaClient, ollamaConfigFromEnv } from '../ai/ollama.js';
import { InstagramConnection } from '../instagram/oauth.js';
import { listAudit, recordAudit } from '../ops/audit.js';
import { workStatus } from '../ops/work.js';
import { AiQueue } from '../ai/queue.js';
import { registerAiRoutes } from '../ai/routes.js';
import { registerSearchRoutes } from '../search/routes.js';
import { registerCollectionRoutes } from '../collections/routes.js';
import { registerCuratorRoutes } from '../curator/routes.js';
import { registerMapRoutes } from '../map/routes.js';
import { opsStatus, storageReport } from '../ops/storage.js';
import { registerPublishingRoutes } from '../publishing/routes.js';
import { PublishingService } from '../publishing/service.js';
import { registerInstagramRoutes } from '../instagram/routes.js';
import { InstagramService } from '../instagram/service.js';
import { MapService } from '../map/service.js';
import { CuratorService } from '../curator/service.js';
import { CollectionService } from '../collections/service.js';
import { SearchService } from '../search/service.js';
import { registerImportRoutes } from '../ingest/routes.js';
import { sourceConfigFromEnv } from '../ingest/source.js';
import { Geocoder } from '../geo/geocoder.js';
import { registerManagementRoutes } from '../library/routes-manage.js';
import { LibraryService } from '../library/service.js';
import { defaultStateDir } from '../paths.js';

export const VERSION = '0.5.0';
export const SESSION_COOKIE = 'jp_session';
/** Over HTTPS the cookie carries the __Host- prefix: browsers then refuse to store it unless it is Secure, Path=/ and has no Domain, and refuse any sibling that tries to overwrite it without those. */
export const SECURE_SESSION_COOKIE = '__Host-jp_session';
const SESSION_MAX_AGE = 30 * 24 * 3600;

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export interface AppDeps {
  config: Pick<AppConfig, 'logLevel' | 'allowedHosts' | 'cookieSecure' | 'webDir'> & Partial<Pick<AppConfig, 'derivativesDir' | 'syntheticMedia' | 'ingestDir' | 'stateDir' | 'igMediaDir'>> & { backupDir?: string | null; deliveryDir?: string | null; instagramOAuth?: import('../instagram/oauth.js').IgOAuthConfig | null; atRestKey?: Buffer; dataRoot?: import('../storage/dataRoot.js').DataRoot | null };
  sql: Sql;
  auth: AuthService;
  sessionSecret: Buffer;
  now?: () => number;
  /** test hook: receives every route as it is registered (used by the route-inventory security test) */
  routeSink?: (r: { method: string; url: string }) => void;
  /** place-name lookups (tests inject one with a fake transport; production uses OpenStreetMap's Nominatim) */
  geocoder?: Geocoder;
}

declare module 'fastify' {
  interface FastifyRequest { session: { userId: string; sessionId: string; token: string } | null }
}

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(1).max(256);
const Code = z.string().trim().min(6).max(32);
const Challenge = z.string().min(20).max(1024);
const Uuid = z.string().uuid();

const hostOf = (h: string | undefined): string => (h ?? '').toLowerCase().replace(/:\d+$/, '');
/** The host the browser used. X-Forwarded-Host is honoured ONLY when the request comes from the local proxy (trustProxy: loopback). */
const effectiveHost = (req: FastifyRequest): string => (req.host || req.headers.host || '').toLowerCase();

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, sql, auth, sessionSecret } = deps;
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'] },
    bodyLimit: 64 * 1024,
    trustProxy: ['127.0.0.1', '::1'],      // only a local reverse proxy may set X-Forwarded-*
    routerOptions: { maxParamLength: 200 },
  });
  if (deps.routeSink) app.addHook('onRoute', (r) => { for (const m of ([] as string[]).concat(r.method)) deps.routeSink!({ method: m, url: r.url }); });
  void app.register(fastifyCookie);
  app.decorateRequest('session', null);
  const loginLimiter = new RateLimiter(30, 60_000, now);

  const ctxOf = (req: FastifyRequest): ClientCtx => ({ ip: req.ip || null, userAgent: (req.headers['user-agent'] as string | undefined) ?? null });
  const isHttps = (req: FastifyRequest) => config.cookieSecure === 'always' || (config.cookieSecure === 'auto' && req.protocol === 'https');
  const fail = (reply: FastifyReply, code: number, error: string, message: string, extra: Record<string, unknown> = {}) => reply.code(code).send({ error, message, ...extra });

  // ---- 1. Host allow-list (defeats DNS rebinding and stray reverse proxies)
  app.addHook('onRequest', async (req, reply) => {
    if (!config.allowedHosts.includes(hostOf(effectiveHost(req)))) return fail(reply, 421, 'bad_host', 'This host name is not allowed.');
  });

  // ---- 2. Hardening headers; API responses are never cached
  // Security audit trail: every successful state-changing call on a sensitive route is recorded (route pattern, ids, status, address — never the body)
  const AUDITED = /^\/api\/(auth\/(logout|password|sessions)|instagram\/(connect|disconnect|oauth\/callback)|imports\/(runs|review|jobs)|ai\/queue\/(pause|resume|cancel|prioritize)|publishing\/(drafts\/:id\/(approve|schedule|ready|unready|cancel|reopen)|schedule\/:id\/cancel))/;
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? ''; const uid = req.session?.userId;
    if (!uid || !AUDITED.test(route) || reply.statusCode >= 400 || (req.method === 'GET' && !route.includes('/oauth/callback'))) return;
    const id = (req.params as { id?: string } | undefined)?.id;
    await recordAudit(sql, uid, `${req.method.toLowerCase()}:${route.replace(/^\/api\//, '')}`, req.ip ?? null, { route, method: req.method, status: reply.statusCode, ...(id ? { id } : {}) }, (e) => req.log.error({ msg: e instanceof Error ? e.message : String(e) }, 'audit write failed'));
  });
  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');   // only the owner-only image endpoint sets its own (private) caching
    if (isHttps(req)) reply.header('strict-transport-security', 'max-age=31536000');
  });

  // ---- 3. Same-origin check on every state-changing request (CSRF layer 1)
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    let ok: boolean;
    if (origin) { try { ok = new URL(origin).host.toLowerCase() === effectiveHost(req); } catch { ok = false; } }
    else ok = site === 'same-origin' || site === 'none';
    if (site && site !== 'same-origin' && site !== 'none') ok = false;
    if (!ok) return fail(reply, 403, 'cross_origin', 'Cross-site requests are not allowed.');
    if (req.url.startsWith('/api/') && req.headers['content-type'] && !String(req.headers['content-type']).startsWith('application/json') && req.method !== 'DELETE')
      return fail(reply, 415, 'unsupported_media_type', 'JSON only.');
  });

  const cookieName = (req: FastifyRequest) => (isHttps(req) ? SECURE_SESSION_COOKIE : SESSION_COOKIE);

  // ---- session resolution + CSRF layer 2 for authenticated calls
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[cookieName(req)];   // over HTTPS only the __Host- cookie is read: a plain cookie planted by a sibling app on the same host name is ignored
    const s = await auth.resolve(token);
    if (!s || !token) return fail(reply, 401, 'unauthenticated', 'Please sign in.');
    req.session = { ...s, token };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfValid(sessionSecret, token, req.headers['x-csrf-token'] as string | undefined))
      return fail(reply, 403, 'bad_csrf', 'Missing or invalid CSRF token.');
  };

  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(cookieName(req), token, { httpOnly: true, sameSite: 'lax', path: '/', secure: isHttps(req), maxAge: SESSION_MAX_AGE });
  const clearSessionCookie = (req: FastifyRequest, reply: FastifyReply) =>
    reply.clearCookie(cookieName(req), { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps(req) });

  const throttle = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const wait = loginLimiter.take(`ip:${req.ip}`);
    if (wait) { reply.header('retry-after', String(wait)); fail(reply, 429, 'rate_limited', 'Too many requests. Try again shortly.', { retryAfter: wait }); return true; }
    return false;
  };
  const lockedReply = (reply: FastifyReply, retryAfter: number) => { reply.header('retry-after', String(retryAfter)); return fail(reply, 429, 'locked', 'Too many failed attempts. Try again later.', { retryAfter }); };
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply): z.infer<T> | null => {
    const r = schema.safeParse(req.body);
    if (!r.success) { fail(reply, 400, 'invalid_request', 'The request was not valid.'); return null; }
    return r.data;
  };

  // ------------------------------------------------------------------ public
  app.get('/api/health', async (_req, reply) => {
    let database: 'ok' | 'error' = 'ok';
    try { await sql`SELECT 1`; } catch { database = 'error'; }
    return reply.code(database === 'ok' ? 200 : 503).send({ status: database === 'ok' ? 'ok' : 'degraded', service: 'photovault-api', version: VERSION, database });
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (throttle(req, reply)) return;
    const b = body(z.object({ email: Email, password: Password }), req, reply); if (!b) return;
    const r = await auth.loginPassword(b.email, b.password, ctxOf(req));
    if (r.status === 'locked') return lockedReply(reply, r.retryAfter);
    if (r.status === 'invalid') return fail(reply, 401, 'invalid_credentials', 'Email or password is incorrect.');
    return { step: r.status, challenge: r.challenge };
  });

  app.post('/api/auth/mfa', async (req, reply) => {
    if (throttle(req, reply)) return;
    const b = body(z.object({ challenge: Challenge, code: Code }), req, reply); if (!b) return;
    const r = await auth.loginSecondFactor(b.challenge, b.code, ctxOf(req));
    if (r.status === 'locked') return lockedReply(reply, r.retryAfter);
    if (r.status === 'invalid') return fail(reply, 401, 'invalid_code', 'That code is not valid.');
    setSessionCookie(req, reply, r.sessionToken);
    return { step: 'done' };
  });

  app.post('/api/auth/totp/setup', async (req, reply) => {
    if (throttle(req, reply)) return;
    const b = body(z.object({ challenge: Challenge }), req, reply); if (!b) return;
    const r = await auth.totpSetup(b.challenge);
    if (!r) return fail(reply, 401, 'invalid_challenge', 'Please sign in again.');
    return r;
  });

  app.post('/api/auth/totp/confirm', async (req, reply) => {
    if (throttle(req, reply)) return;
    const b = body(z.object({ challenge: Challenge, code: Code }), req, reply); if (!b) return;
    const r = await auth.totpConfirm(b.challenge, b.code, ctxOf(req));
    if (r.status === 'locked') return lockedReply(reply, r.retryAfter);
    if (r.status === 'invalid') return fail(reply, 401, 'invalid_code', 'That code is not valid.');
    setSessionCookie(req, reply, r.sessionToken);
    return { step: 'done', recoveryCodes: r.recoveryCodes };
  });

  // ------------------------------------------------------------------ authenticated
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const s = req.session!;
    const [me, settings] = await Promise.all([auth.me(s.userId), auth.getSettings(s.userId)]);
    if (!me) return fail(reply, 401, 'unauthenticated', 'Please sign in.');
    return { user: me, settings, csrfToken: csrfFor(sessionSecret, s.token) };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const s = req.session!;
    await auth.revokeSession(s.userId, s.sessionId);
    clearSessionCookie(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => ({ sessions: await auth.listSessions(req.session!.userId, req.session!.sessionId) }));

  app.delete('/api/auth/sessions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return fail(reply, 400, 'invalid_request', 'The request was not valid.');
    const ok = await auth.revokeSession(req.session!.userId, id.data);
    if (!ok) return fail(reply, 404, 'not_found', 'No such session.');       // also the answer for another user's session (RLS hides it)
    if (id.data === req.session!.sessionId) clearSessionCookie(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', { preHandler: requireAuth }, async (req) => ({ revoked: await auth.revokeOthers(req.session!.userId, req.session!.sessionId) }));

  app.post('/api/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const b = body(z.object({ current: Password, next: z.string().min(1).max(256) }), req, reply); if (!b) return;
    const r = await auth.changePassword(req.session!.userId, b.current, b.next, req.session!.sessionId, ctxOf(req));
    if (r === 'locked') return lockedReply(reply, 900);
    if (r === 'wrong_password') return fail(reply, 403, 'wrong_password', 'The current password is not correct.');
    if (r === 'weak') return fail(reply, 400, 'weak_password', passwordProblem(b.next) ?? 'Choose a stronger password.');
    return { ok: true };
  });

  app.get('/api/settings', { preHandler: requireAuth }, async (req) => auth.getSettings(req.session!.userId));
  app.patch('/api/settings', { preHandler: requireAuth }, async (req, reply) => {
    const b = body(z.object({ viewerSurface: z.enum(['neutral', 'teal']).optional(), thumbSize: z.number().int().min(80).max(640).optional(), aiScoresVisible: z.boolean().optional() }).strict(), req, reply); if (!b) return;
    return auth.patchSettings(req.session!.userId, b);
  });

  app.get('/api/system/status', { preHandler: requireAuth }, async () => {
    const t = Date.now();
    let db: { ok: boolean; latencyMs: number; version?: string };
    try { const [r] = await sql<{ v: string }[]>`SELECT current_setting('server_version') AS v`; db = { ok: true, latencyMs: Date.now() - t, version: r!.v }; } catch { db = { ok: false, latencyMs: Date.now() - t }; }
    return { api: { ok: true, version: VERSION, uptimeSeconds: Math.round(process.uptime()), node: process.version }, database: db, time: new Date().toISOString() };
  });

  // housekeeping: heartbeats of the background processes, backup freshness, and what the system occupies (read-only)
  app.get('/api/system/ops', { preHandler: requireAuth }, async () => opsStatus(sql));
  app.get('/api/system/audit', { preHandler: requireAuth }, async (req) => ({ events: await listAudit(sql, req.session!.userId, Number((req.query as { limit?: string }).limit) || 50) }));
  // one list of everything that needs attention: lost heartbeats come first, then the work queues
  app.get('/api/system/work', { preHandler: requireAuth }, async (req) => {
    const [w, o] = await Promise.all([workStatus(sql, req.session!.userId), opsStatus(sql)]);
    const first: string[] = [];
    for (const sv of o.services) if (sv.status !== 'running') first.push(`${sv.name === 'worker' ? 'The background worker' : sv.name === 'scheduler' ? 'The publisher' : sv.name} is ${sv.status === 'late' ? 'late reporting' : 'not running'} (last seen ${sv.ageSeconds === null ? 'never' : `${Math.round(sv.ageSeconds / 60)} min ago`})`);
    return { ...w, problems: [...first, ...w.problems] };
  });
  // the external photo drive (identified by its volume UUID): is it usable right now?
  app.get('/api/system/data-root', { preHandler: requireAuth }, async () => {
    if (!config.dataRoot) return { configured: false };
    const st = await config.dataRoot.status();
    return { configured: true, ready: st.ready, reason: st.reason, storageId: st.storageId, mountedAt: st.mountPoint, folder: st.root };
  });
  let storageCache: { at: number; value: unknown } | null = null;
  app.get('/api/system/storage', { preHandler: requireAuth }, async () => {
    if (storageCache && Date.now() - storageCache.at < 60_000) return storageCache.value;
    const stateDir = config.stateDir ?? defaultStateDir();
    const dr = config.dataRoot ? await config.dataRoot.status() : null;
    const base = dr?.ready && dr.root ? dr.root : null;
    const value = await storageReport(sql, { derivatives: base ? path.join(base, 'derivatives') : (dr ? null : config.derivativesDir ?? null), igMedia: config.igMediaDir ?? null, delivery: config.deliveryDir ?? null, backups: config.backupDir ?? null, state: stateDir });
    storageCache = { at: Date.now(), value }; return value;
  });

  // ------------------------------------------------------------------ library (Phase 5)
  registerImportRoutes(app, { sql, requireAuth, fail, stateDir: config.stateDir ?? defaultStateDir(), ingestDir: config.ingestDir ?? null, derivativesDir: config.derivativesDir ?? null, source: config.ingestDir ? sourceConfigFromEnv({ ...process.env, PHOTOVAULT_INGEST_DIR: config.ingestDir }) : null });
  registerAiRoutes(app, { ai: new AiService(sql, new OllamaClient(ollamaConfigFromEnv())), queue: new AiQueue(sql), requireAuth, fail });
  const library = new LibraryService(sql);
  const searchService = new SearchService(sql, library, new OllamaClient({ ...ollamaConfigFromEnv(), timeoutMs: 8000 }));
  registerSearchRoutes(app, { service: searchService, requireAuth, fail });
  registerCuratorRoutes(app, { service: new CuratorService(sql, library, searchService), requireAuth, fail });
  registerInstagramRoutes(app, { connection: new InstagramConnection({ sql, cfg: config.instagramOAuth ?? null, atRestKey: config.atRestKey ?? Buffer.alloc(32), stateKey: sessionSecret }), service: new InstagramService({ sql, library, mediaDir: config.igMediaDir ?? null, webDir: config.webDir, derivativesDir: config.derivativesDir ?? null, syntheticAllowed: config.syntheticMedia ?? false }), requireAuth, fail });
  registerPublishingRoutes(app, { service: new PublishingService(sql, library, undefined, new OllamaClient({ ...ollamaConfigFromEnv(), timeoutMs: 90_000 })), requireAuth, fail });
  registerMapRoutes(app, { service: new MapService(sql), requireAuth, fail });
  registerCollectionRoutes(app, { service: new CollectionService(sql, library, searchService), requireAuth, fail });
  registerManagementRoutes(app, { library, edits: new EditService(sql), dups: new DuplicateService(sql), geocoder: deps.geocoder ?? new Geocoder(sql), requireAuth, fail });
  registerLibraryRoutes(app, {
    service: library, requireAuth, fail, webDir: config.webDir,
    derivativesDir: config.derivativesDir ?? null, syntheticMedia: config.syntheticMedia ?? false, storage: config.dataRoot ?? null,
  });

  // ------------------------------------------------------------------ web app (production) + 404s
  const web = config.webDir;
  if (web) {
    void app.register(fastifyStatic, { root: web, wildcard: false, index: false, maxAge: 3_600_000 });   // hashed assets; index.html is served below with no-cache
    const indexHtml = () => fs.readFileSync(path.join(web, 'index.html'));
    app.get('/*', async (req, reply) => {
      const url = req.url.split('?')[0]!;
      if (url.startsWith('/api/')) return fail(reply, 404, 'not_found', 'Not found.');
      const file = path.join(web, url);
      if (url !== '/' && file.startsWith(web) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(url.slice(1));
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(indexHtml());
    });
  }
  app.setNotFoundHandler((_req, reply) => fail(reply, 404, 'not_found', 'Not found.'));
  app.setErrorHandler((err: { statusCode?: number; code?: string }, req, reply) => {
    if (err.statusCode && err.statusCode < 500) return fail(reply, err.statusCode, err.code ?? 'bad_request', 'The request could not be processed.');
    req.log.error({ err }, 'unhandled error');
    return fail(reply, 500, 'internal_error', 'Something went wrong.');
  });
  return app;
}
