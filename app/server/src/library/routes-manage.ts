import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DecideSchema, DuplicateService, ScanSchema } from './duplicates.js';
import type { Geocoder } from '../geo/geocoder.js';
import { EditService, MetaPatchSchema, type GeoLookup } from './edit.js';
import { FiltersSchema } from './query.js';
import type { LibraryService } from './service.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Fail = (reply: FastifyReply, code: number, error: string, message: string, extra?: Record<string, unknown>) => FastifyReply;
const Uuid = z.string().uuid();

/** Phase 6 endpoints: metadata editing with provenance and history, versions, duplicates, comparison cards, bulk location. */
export function registerManagementRoutes(app: FastifyInstance, d: { library: LibraryService; edits: EditService; dups: DuplicateService; geocoder: Geocoder; requireAuth: Guard; fail: Fail }): void {
  const { library, edits, dups, geocoder, requireAuth, fail } = d;
  const bad = (reply: FastifyReply) => fail(reply, 400, 'invalid_request', 'The request was not valid.');
  const nf = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'No such photograph.');
  const idParam = (req: FastifyRequest) => Uuid.safeParse((req.params as { id: string }).id);

  app.patch('/api/library/photos/:id/metadata', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); const p = MetaPatchSchema.safeParse(req.body);
    if (!id.success || !p.success) return bad(reply);
    // a place name is looked up BEFORE the database transaction (a slow or unreachable service must never hold a row lock, and never makes the edit fail)
    const q = await edits.geocodeQuery(req.session!.userId, id.data, p.data);
    const geo: GeoLookup | undefined = q === null ? undefined : q === '' ? { query: '', result: { status: 'not_found', cached: true } } : { query: q, result: await geocoder.lookup(req.session!.userId, q) };
    const r = await edits.edit(req.session!.userId, id.data, p.data, geo);
    return r.status === 'ok' ? r : nf(reply);
  });

  // candidate positions for a typed place name, for the "Find on map" choice list. Explicit action only (never as-you-type); the service is rate-limited and cached.
  app.get('/api/geocode', { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().min(2).max(120) }).strict().safeParse(req.query); if (!q.success) return bad(reply);
    const r = await geocoder.lookup(req.session!.userId, q.data.q, 5);
    return { enabled: geocoder.enabled, attribution: '© OpenStreetMap contributors', ...r };
  });

  app.get('/api/library/photos/:id/history', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); if (!id.success) return bad(reply);
    const h = await edits.history(req.session!.userId, id.data);
    return h ? { edits: h } : nf(reply);
  });

  app.post('/api/library/photos/:id/history/:editId/undo', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); const eid = Uuid.safeParse((req.params as { editId: string }).editId);
    if (!id.success || !eid.success) return bad(reply);
    const r = await edits.undo(req.session!.userId, id.data, eid.data);
    if (r.status === 'ok') return { ok: true };
    if (r.status === 'not_found') return nf(reply);
    return fail(reply, 409, r.status, r.status === 'conflict' ? 'This value has changed since that edit, so it cannot be undone safely.' : r.status === 'already_undone' ? 'That edit was already undone.' : 'An undo cannot be undone; edit the value instead.');
  });

  app.get('/api/library/photos/:id/versions', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); if (!id.success) return bad(reply);
    const v = await edits.versions(req.session!.userId, id.data);
    return v ? { versions: v } : nf(reply);
  });

  app.post('/api/library/photos/:id/versions/:versionId/restore', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); const vid = Uuid.safeParse((req.params as { versionId: string }).versionId);
    if (!id.success || !vid.success) return bad(reply);
    const r = await edits.restoreVersion(req.session!.userId, id.data, vid.data);
    return r.status === 'ok' ? r : nf(reply);
  });

  app.get('/api/library/photos/:id/duplicates', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); if (!id.success) return bad(reply);
    const r = await dups.forPhoto(req.session!.userId, id.data);
    return r ? { pairs: r } : nf(reply);
  });

  app.get('/api/library/duplicates', { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ state: z.enum(['OPEN', 'DUPLICATE', 'DISTINCT']).default('OPEN'), limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(120).optional() }).strict().safeParse(req.query);
    if (!q.success) return bad(reply);
    let cursor: { d: number; id: string } | undefined;
    if (q.data.cursor) {
      const [dd, ii] = q.data.cursor.split(':');
      if (!Uuid.safeParse(ii).success || !/^\d{1,2}$/.test(dd ?? '')) return fail(reply, 400, 'invalid_cursor', 'The page position is no longer valid.');
      cursor = { d: Number(dd), id: ii! };
    }
    const r = await dups.list(req.session!.userId, { state: q.data.state, limit: q.data.limit, cursor });
    return { items: r.items, total: r.total, nextCursor: r.next ? `${r.next.d}:${r.next.id}` : null };
  });

  app.post('/api/library/duplicates/scan', { preHandler: requireAuth }, async (req, reply) => {
    const b = ScanSchema.safeParse(req.body ?? {}); if (!b.success) return bad(reply);
    return dups.scan(req.session!.userId, b.data.maxDistance);
  });

  app.post('/api/library/duplicates/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam(req); const b = DecideSchema.safeParse(req.body);
    if (!id.success || !b.success) return bad(reply);
    return (await dups.decide(req.session!.userId, id.data, b.data.state)) ? { ok: true } : fail(reply, 404, 'not_found', 'No such pair.');
  });

  /** Cards for the comparison view: 2–4 photographs in the order asked for. */
  app.get('/api/library/compare', { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ ids: z.string().max(400) }).strict().safeParse(req.query); if (!q.success) return bad(reply);
    const ids = q.data.ids.split(',');
    if (ids.length < 2 || ids.length > 4 || !ids.every((i) => Uuid.safeParse(i).success)) return bad(reply);
    const cards = await library.cards(req.session!.userId, ids);
    const details = await Promise.all(cards.map((c) => library.detail(req.session!.userId, c.id)));
    return { photos: details.filter(Boolean), cards };
  });

  // Put every photograph whose typed place name has no position yet on the map: one lookup per DISTINCT name (rate-limited, cached), at most 20 names per press.
  app.post('/api/library/photos/locate-named', { preHandler: requireAuth }, async (req, reply) => {
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) return bad(reply);
    const user = req.session!.userId; const names = await edits.unplacedNames(user, 20); const results = [];
    for (const n of names) results.push({ ...(await edits.placeNamed(user, n.text, { query: n.text, result: await geocoder.lookup(user, n.text) })), expected: n.photos });
    return { names: names.length, placed: results.reduce((a, r) => a + (r.status === 'placed' ? r.photos : 0), 0), results };
  });

  app.post('/api/library/photos/bulk-location', { preHandler: requireAuth }, async (req, reply) => {
    const b = z.object({
      target: z.union([z.object({ ids: z.array(Uuid).min(1).max(500) }).strict(), z.object({ query: FiltersSchema, exclude: z.array(Uuid).max(1000).default([]) }).strict()]),
      location: z.string().trim().max(120).nullable(),
    }).strict().safeParse(req.body);
    if (!b.success) return bad(reply);
    const text = b.data.location?.trim() || null;
    const geo: GeoLookup | undefined = text === null ? { query: '', result: { status: 'not_found', cached: true } } : { query: text, result: await geocoder.lookup(req.session!.userId, text) };
    return edits.bulkLocation(req.session!.userId, b.data.target, b.data.location, geo);
  });
}
