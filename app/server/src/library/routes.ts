import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FiltersSchema, ListSchema } from './query.js';
import { PrefsSchema, type LibraryService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;

export interface LibraryRouteDeps {
  service: LibraryService;
  requireAuth: Guard;
  fail: Fail;
  /** Built web app; synthetic development photographs are drawn from its /fixtures folder. */
  webDir: string | null;
  /** Where generated previews live (DATA_ROOT/derivatives). Null until the import pipeline exists (Phase 7). */
  derivativesDir: string | null;
  /** the external photo drive, found by volume identity; when set it decides where previews are and whether they can be served */
  storage?: import('../storage/dataRoot.js').DataRoot | null;
  /** True only for non-production databases: synthetic fixtures may be served as image data. */
  syntheticMedia: boolean;
}

const Uuid = z.string().uuid();
const PhotoSetSchema = z.object({ rating: z.number().int().min(0).max(5).optional(), favorite: z.boolean().optional(), portfolio: z.boolean().optional(), hidden: z.boolean().optional() })
  .strict().refine((s) => Object.keys(s).length > 0, 'nothing to change');
const BulkSchema = z.object({
  target: z.union([
    z.object({ ids: z.array(Uuid).min(1).max(500) }).strict(),
    z.object({ query: FiltersSchema, exclude: z.array(Uuid).max(1000).default([]) }).strict(),
  ]),
  set: PhotoSetSchema,
}).strict();

const SIZES = new Set(['thumb', 'view']);
const here = path.dirname(fileURLToPath(import.meta.url));

export function registerLibraryRoutes(app: FastifyInstance, d: LibraryRouteDeps): void {
  const { service, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');

  app.get('/api/library/photos', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListSchema.safeParse(req.query); if (!q.success) return bad(reply);
    const r = await service.list(req.session!.userId, q.data);
    if ('invalidCursor' in r) return fail(reply, 400, 'invalid_cursor', 'The page position is no longer valid. Reload the library.');
    return r;
  });

  app.get('/api/library/facets', { preHandler: requireAuth }, async (req) => service.facets(req.session!.userId));

  app.get('/api/library/photos/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); if (!id.success) return bad(reply);
    const r = await service.detail(req.session!.userId, id.data);
    return r ?? fail(reply, 404, 'not_found', 'No such photograph.');       // also the answer for another user's photograph (RLS hides it)
  });

  app.patch('/api/library/photos/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id); const set = PhotoSetSchema.safeParse(req.body);
    if (!id.success || !set.success) return bad(reply);
    const ok = await service.update(req.session!.userId, id.data, set.data);
    return ok ? { ok: true } : fail(reply, 404, 'not_found', 'No such photograph.');
  });

  app.post('/api/library/photos/bulk', { preHandler: requireAuth }, async (req, reply) => {
    const b = BulkSchema.safeParse(req.body); if (!b.success) return bad(reply);
    return service.bulk(req.session!.userId, b.data.target, b.data.set);
  });

  app.get('/api/library/preferences', { preHandler: requireAuth }, async (req) => service.getPreferences(req.session!.userId));
  app.put('/api/library/preferences', { preHandler: requireAuth }, async (req, reply) => {
    const p = PrefsSchema.safeParse(req.body); if (!p.success) return bad(reply);
    return service.setPreferences(req.session!.userId, p.data);
  });

  // Photographs are only ever served to their signed-in owner, never from a public URL.
  app.get('/api/library/photos/:id/image', { preHandler: requireAuth }, async (req, reply) => {
    const id = Uuid.safeParse((req.params as { id: string }).id);
    const size = (req.query as { size?: string }).size ?? 'thumb';
    if (!id.success || !SIZES.has(size)) return bad(reply);
    const src = await service.imageSource(req.session!.userId, id.data);
    if (!src) return fail(reply, 404, 'not_found', 'No such photograph.');

    let derivDir = d.derivativesDir;
    if (d.storage && src.fixture === null) {
      const why = await d.storage.gate();
      if (why) return fail(reply, 503, 'storage_unavailable', `The photo drive is not available (${why}). Previews return when it is connected.`);
      derivDir = await d.storage.dir('derivatives');
    }
    let file: string | null = null;
    if (src.fixture !== null) {
      // synthetic development data only: fixture ids are validated and the folder is fixed, so no path comes from the request
      if (!d.syntheticMedia || !/^p\d{2}$/.test(src.fixture)) return fail(reply, 404, 'not_found', 'No preview.');
      const dirs = [d.webDir ? path.join(d.webDir, 'fixtures') : null, path.resolve(here, '../../../web/public/fixtures')].filter((x): x is string => !!x);
      file = dirs.map((dir) => path.join(dir, `${src.fixture}.jpg`)).find((f) => fs.existsSync(f)) ?? null;
    } else if (derivDir && src.derivStatus === 'READY') {
      file = path.join(derivDir, src.versionId, `${size}.jpg`);
      if (!file.startsWith(derivDir + path.sep) || !fs.existsSync(file)) file = null;
    }
    if (!file) return fail(reply, 404, 'no_preview', 'No preview has been generated for this photograph yet.');

    const etag = `"${src.versionId}-${size}"`;
    reply.header('etag', etag).header('cache-control', 'private, max-age=3600');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/jpeg').header('content-disposition', 'inline').send(fs.createReadStream(file));
  });
}
