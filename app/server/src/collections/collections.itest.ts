import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let ua: string, ub: string;
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); app = makeApp(h);
  ua = await makeUser(h.svc, 'a@example.test'); ub = await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const ids = (b: { items: Array<{ id: string }> }) => b.items.map((i) => i.id);
const mk = async (user: string, n: number, o: Parameters<typeof seedOne>[2] = {}) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push((await seedOne(h!.svc, user, { title: `c-${i}`, captureAt: new Date(Date.UTC(2024, 0, 1 + i)), ...o })).photoId); return out; };
const photos = async (c: ApiClient, id: string, q = '') => (await c.json('GET', `/api/collections/${id}/photos${q}`));

describe('manual collections', () => {
  it('create with members; count and cover come from the first photograph; names are unique (case-insensitive)', async (ctx) => {
    need(ctx);
    const p = await mk(ua, 4);
    const r = await A.json('POST', '/api/collections', { name: 'Best of Kenya', description: 'A set', ids: [p[2]!, p[0]!, p[1]!] }); expect(r.status).toBe(201);
    const c = (await A.json('GET', `/api/collections/${r.body.id}`)).body;
    expect(c).toMatchObject({ name: 'Best of Kenya', kind: 'MANUAL', status: 'ACTIVE', count: 3, cover: p[2], coverIsChosen: false, dynamic: false, description: 'A set' });
    expect(ids((await photos(A, r.body.id)).body)).toEqual([p[2], p[0], p[1]]);                         // the order given, not capture order
    expect((await A.json('POST', '/api/collections', { name: 'best of KENYA' })).status).toBe(409);
    expect((await A.json('POST', '/api/collections', { name: '   ' })).status).toBe(400);
    expect((await A.json('POST', '/api/collections', { name: 'x', kind: 'MANUAL', filters: {} })).status).toBe(400);
    expect((await A.json('GET', '/api/collections')).body.items.map((x: { name: string }) => x.name)).toContain('Best of Kenya');
  });

  it('adding is idempotent, appends at the end, and cannot reach another account’s photographs', async (ctx) => {
    need(ctx);
    const [a1, a2, a3] = await mk(ua, 3); const [b1] = await mk(ub, 1);
    const c = (await A.json('POST', '/api/collections', { name: 'Add test', ids: [a1!] })).body.id;
    expect((await A.json('POST', `/api/collections/${c}/photos`, { target: { ids: [a1!, a2!, b1!, randomUUID()] } })).body).toEqual({ added: 1, alreadyIn: 3 });
    expect((await A.json('POST', `/api/collections/${c}/photos`, { target: { ids: [a3!, a2!] } })).body).toEqual({ added: 1, alreadyIn: 1 });
    expect(ids((await photos(A, c)).body)).toEqual([a1, a2, a3]);
    const pos = await h!.svc`SELECT position FROM collection_photos WHERE collection_id = ${c} ORDER BY position`; expect(pos.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it('adds "everything matching these filters except …" (select-all in the Library)', async (ctx) => {
    need(ctx);
    const five = await mk(ua, 5, { rating: 5, location: 'Matchland' }); await mk(ua, 2, { rating: 1, location: 'Matchland' });
    const c = (await A.json('POST', '/api/collections', { name: 'By filter' })).body.id;
    const r = await A.json('POST', `/api/collections/${c}/photos`, { target: { query: { view: 'all', location: ['Matchland'], rating: [5] }, exclude: [five[0]!] } });
    expect(r.body).toEqual({ added: 4, alreadyIn: 0 });
    expect(new Set(ids((await photos(A, c)).body))).toEqual(new Set(five.slice(1)));
  });

  it('pages in order with a cursor; hidden and deleted photographs do not show or count', async (ctx) => {
    need(ctx);
    const p = await mk(ua, 7);
    const c = (await A.json('POST', '/api/collections', { name: 'Paging', ids: p })).body.id;
    await h!.svc`UPDATE photos SET hidden = true WHERE id = ${p[1]!}`; await h!.svc`UPDATE photos SET deleted_at = now() WHERE id = ${p[2]!}`;
    const p1 = (await photos(A, c, '?limit=2')).body; expect(p1.total).toBe(5); expect(ids(p1)).toEqual([p[0], p[3]]); expect(p1.nextCursor).toBe('2');
    const p2 = (await photos(A, c, '?limit=2&cursor=2')).body; const p3 = (await photos(A, c, '?limit=2&cursor=4')).body;
    expect([...ids(p2), ...ids(p3)]).toEqual([p[4], p[5], p[6]]); expect(p3.nextCursor).toBeNull();
    expect((await A.json('GET', `/api/collections/${c}`)).body.count).toBe(5);
    expect((await photos(A, c, '?cursor=-1')).status).toBe(400); expect((await photos(A, c, '?limit=1000')).status).toBe(400);
  });

  it('reorders: move to the front, to the end, before another; relative order of the moved set is kept; bad targets are refused', async (ctx) => {
    need(ctx);
    const [a, b, c2, d, e] = await mk(ua, 5);
    const c = (await A.json('POST', '/api/collections', { name: 'Order', ids: [a!, b!, c2!, d!, e!] })).body.id;
    const order = async () => ids((await photos(A, c)).body);
    expect((await A.json('POST', `/api/collections/${c}/move`, { ids: [e!], before: a! })).status).toBe(200); expect(await order()).toEqual([e, a, b, c2, d]);
    await A.json('POST', `/api/collections/${c}/move`, { ids: [e!, a!], before: null }); expect(await order()).toEqual([b, c2, d, e, a]);
    await A.json('POST', `/api/collections/${c}/move`, { ids: [a!, b!], before: d! }); expect(await order()).toEqual([c2, a, b, d, e]);
    expect((await A.json('POST', `/api/collections/${c}/move`, { ids: [a!], before: a! })).status).toBe(400);
    expect((await A.json('POST', `/api/collections/${c}/move`, { ids: [a!], before: randomUUID() })).status).toBe(400);
    expect((await A.json('POST', `/api/collections/${c}/move`, { ids: [randomUUID()], before: null })).status).toBe(400);
    expect(await order()).toEqual([c2, a, b, d, e]);
  });

  it('cover must be a member; removing the cover resets it; removal leaves the photograph itself untouched', async (ctx) => {
    need(ctx);
    const [a, b, outsider] = await mk(ua, 3);
    const c = (await A.json('POST', '/api/collections', { name: 'Covers', ids: [a!, b!] })).body.id;
    expect((await A.json('PATCH', `/api/collections/${c}`, { coverPhotoId: outsider! })).status).toBe(400);
    expect((await A.json('PATCH', `/api/collections/${c}`, { coverPhotoId: b! })).status).toBe(200);
    expect((await A.json('GET', `/api/collections/${c}`)).body).toMatchObject({ cover: b, coverIsChosen: true });
    expect((await A.json('DELETE', `/api/collections/${c}/photos`, { ids: [b!] })).body).toEqual({ removed: 1 });
    expect((await A.json('GET', `/api/collections/${c}`)).body).toMatchObject({ cover: a, coverIsChosen: false, count: 1 });
    expect((await h!.svc`SELECT 1 FROM photos WHERE id = ${b!}`).length).toBe(1);
    expect((await A.json('PATCH', `/api/collections/${c}`, { name: 'Renamed', description: null, coverPhotoId: null })).status).toBe(200);
  });

  it('deleting a collection never deletes photographs', async (ctx) => {
    need(ctx);
    const [a] = await mk(ua, 1); const c = (await A.json('POST', '/api/collections', { name: 'Temp', ids: [a!] })).body.id;
    expect((await A.json('DELETE', `/api/collections/${c}`)).status).toBe(200); expect((await A.json('GET', `/api/collections/${c}`)).status).toBe(404);
    expect((await h!.svc`SELECT deleted_at FROM photos WHERE id = ${a!}`)[0]!.deleted_at).toBeNull();
  });

  it('the photograph detail lists the collections it belongs to', async (ctx) => {
    need(ctx);
    const [a] = await mk(ua, 1); await A.json('POST', '/api/collections', { name: 'Shown in detail', ids: [a!] });
    expect((await A.json('GET', `/api/library/photos/${a}`)).body.collections.map((c: { name: string }) => c.name)).toEqual(['Shown in detail']);
  });
});

describe('smart collections (live queries)', () => {
  it('membership follows the data: a new matching photograph appears without anyone adding it', async (ctx) => {
    need(ctx);
    await mk(ua, 2, { rating: 5, location: 'Livestock' });
    const c = (await A.json('POST', '/api/collections', { name: 'Five stars in Livestock', kind: 'SMART', filters: { view: 'all', rating: [5], location: ['Livestock'] } })).body.id;
    expect((await A.json('GET', `/api/collections/${c}`)).body).toMatchObject({ kind: 'SMART', dynamic: true, count: 2 });
    const [fresh] = await mk(ua, 1, { rating: 5, location: 'Livestock', captureAt: new Date('2025-05-05T00:00:00Z') });
    const page = (await photos(A, c)).body; expect(page.total).toBe(3); expect(ids(page)[0]).toBe(fresh);       // newest first
    await h!.svc`UPDATE photos SET rating = 2 WHERE id = ${fresh!}`; expect((await photos(A, c)).body.total).toBe(2);
  });
  it('is read-only as a list (add / remove / move refused), its filters can be edited, and a manual collection cannot take filters', async (ctx) => {
    need(ctx);
    const [a] = await mk(ua, 1, { location: 'ReadOnly' });
    const c = (await A.json('POST', '/api/collections', { name: 'Smart ro', kind: 'SMART', filters: { view: 'all', location: ['ReadOnly'] } })).body.id;
    for (const [m, u, b] of [['POST', 'photos', { target: { ids: [a!] } }], ['DELETE', 'photos', { ids: [a!] }], ['POST', 'move', { ids: [a!], before: null }]] as const) expect((await A.json(m, `/api/collections/${c}/${u}`, b)).status, u).toBe(409);
    expect((await A.json('PATCH', `/api/collections/${c}`, { filters: { view: 'all', location: ['Nowhere'] } })).status).toBe(200); expect((await A.json('GET', `/api/collections/${c}`)).body.count).toBe(0);
    const m = (await A.json('POST', '/api/collections', { name: 'Manual', ids: [a!] })).body.id; expect((await A.json('PATCH', `/api/collections/${m}`, { filters: { view: 'all' } })).status).toBe(400);
    expect((await A.json('POST', '/api/collections', { name: 'No filters', kind: 'SMART' })).status).toBe(400);
  });
  it('rejects filters the Library would reject', async (ctx) => {
    need(ctx);
    expect((await A.json('POST', '/api/collections', { name: 'Bad', kind: 'SMART', filters: { view: 'all', rating: [9] } })).status).toBe(400);
    expect((await A.json('POST', '/api/collections', { name: 'Bad2', kind: 'SMART', filters: { bogus: 1 } })).status).toBe(400);
  });
});

describe('saved searches and AI drafts appear alongside', () => {
  it('a saved search is a dynamic collection with a live count, and pages its results', async (ctx) => {
    need(ctx);
    await mk(ua, 3, { title: 'Quetzal flight' });
    const s = (await A.json('POST', '/api/search/saved', { name: 'Quetzals', q: 'quetzal' })).body.id;
    const c = (await A.json('GET', `/api/collections/${s}`)).body; expect(c).toMatchObject({ kind: 'SAVED_SEARCH', dynamic: true, count: 3, search: { q: 'quetzal', exclude: [] } });
    expect((await photos(A, s, '?limit=2')).body).toMatchObject({ total: 3, nextCursor: '2' });
    expect((await A.json('POST', `/api/collections/${s}/photos`, { target: { ids: [randomUUID()] } })).status).toBe(409);
    expect((await A.json('DELETE', `/api/collections/${s}`)).status).toBe(200); expect((await A.json('GET', '/api/search/saved')).body.items.find((x: { id: string }) => x.id === s)).toBeUndefined();
  });
  it('an AI draft stays out of the main list until a person activates it, and then becomes an ordinary manual collection', async (ctx) => {
    need(ctx);
    const [a] = await mk(ua, 1);
    const [d] = await h!.svc<{ id: string }[]>`INSERT INTO collections (user_id, name, kind, status, created_by, rationale) VALUES (${ua}, 'Draft: dawn light', 'AI_DRAFT', 'DRAFT', 'AI', 'Photographs taken within an hour of sunrise') RETURNING id`;
    await h!.svc`INSERT INTO collection_photos (user_id, collection_id, photo_id, added_by) VALUES (${ua}, ${d!.id}, ${a!}, 'AI')`;
    expect((await A.json('GET', '/api/collections')).body.items.map((x: { id: string }) => x.id)).not.toContain(d!.id);
    const drafts = (await A.json('GET', '/api/collections?status=DRAFT')).body.items; expect(drafts).toEqual([expect.objectContaining({ id: d!.id, createdBy: 'AI', rationale: expect.stringContaining('sunrise'), count: 1 })]);
    expect((await A.json('POST', `/api/collections/${d!.id}/activate`)).status).toBe(200);
    expect((await A.json('GET', `/api/collections/${d!.id}`)).body).toMatchObject({ kind: 'MANUAL', status: 'ACTIVE' });
    expect((await A.json('POST', `/api/collections/${d!.id}/archive`)).status).toBe(200);
    expect((await A.json('GET', '/api/collections?status=ARCHIVED')).body.items.map((x: { id: string }) => x.id)).toContain(d!.id);
    expect((await A.json('GET', '/api/collections?status=bogus')).status).toBe(400);
  });
});

describe('access control', () => {
  it('another account sees, changes and fills nothing of mine', async (ctx) => {
    need(ctx);
    const [a] = await mk(ua, 1); const [b] = await mk(ub, 1);
    const c = (await A.json('POST', '/api/collections', { name: 'Private set', ids: [a!] })).body.id;
    expect((await B.json('GET', '/api/collections')).body.items.map((x: { id: string }) => x.id)).not.toContain(c);
    for (const [m, u, body] of [['GET', '', undefined], ['PATCH', '', { name: 'x' }], ['DELETE', '', undefined], ['GET', '/photos', undefined], ['POST', '/photos', { target: { ids: [b!] } }], ['DELETE', '/photos', { ids: [a!] }], ['POST', '/move', { ids: [a!], before: null }], ['POST', '/activate', undefined], ['POST', '/archive', undefined]] as const)
      expect((await B.json(m, `/api/collections/${c}${u}`, body)).status, `${m} ${u}`).toBe(404);
    expect((await A.json('GET', `/api/collections/${c}`)).body).toMatchObject({ name: 'Private set', count: 1 });
    expect((await B.json('POST', '/api/collections', { name: 'Private set' })).status).toBe(201);                       // same name, different account
  });
  it('every endpoint needs a session; writes need the CSRF token; ids must be well formed', async (ctx) => {
    need(ctx);
    const anon = new ApiClient(app); const id = randomUUID();
    for (const [m, u] of [['GET', '/api/collections'], ['POST', '/api/collections'], ['GET', `/api/collections/${id}`], ['PATCH', `/api/collections/${id}`], ['DELETE', `/api/collections/${id}`], ['GET', `/api/collections/${id}/photos`], ['POST', `/api/collections/${id}/photos`], ['DELETE', `/api/collections/${id}/photos`], ['POST', `/api/collections/${id}/move`]] as const)
      expect((await anon.json(m, u, m === 'GET' || m === 'DELETE' ? undefined : {})).status, `${m} ${u}`).toBe(401);
    expect((await A.req('POST', '/api/collections', { name: 'no csrf' }, { csrf: false })).statusCode).toBe(403);
    expect((await A.json('GET', '/api/collections/not-a-uuid')).status).toBe(400);
  });
});
