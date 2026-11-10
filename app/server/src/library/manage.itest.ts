import { randomBytes, randomUUID } from 'node:crypto';
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
const row = async (id: string) => (await h!.svc`SELECT * FROM photos WHERE id = ${id}`)[0]!;

describe('metadata editing with provenance and history', () => {
  it('sets title, description, location, date, notes and GPS as USER_DEFINED and records every change', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua, { title: 'IMG_0042', location: 'Kenya', year: 2024, captureAt: new Date('2024-03-12T06:30:00Z') });
    const r = await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'Lioness at dawn', description: 'A lioness watches the plain.', location: 'Masai Mara', captureAt: '2023-12-31T18:15:00.000Z', notes: 'check the crop', gps: { lat: -1.4, lon: 35.1 } });
    expect(r.status).toBe(200); expect(r.body.changed.sort()).toEqual(['capture_at', 'description', 'gps', 'notes', 'title', 'trip_location']);
    const p = await row(photoId);
    expect(p).toMatchObject({ title: 'Lioness at dawn', title_source: 'USER_DEFINED', description: 'A lioness watches the plain.', description_source: 'USER_DEFINED', trip_location: 'Masai Mara', trip_location_source: 'USER_DEFINED', notes: 'check the crop', year: 2024, year_source: 'FOLDER_DERIVED', capture_year: 2023, capture_month: 12, capture_at_source: 'USER_DEFINED' });
    const [v] = await h!.svc`SELECT gps_lat, gps_lon, gps_source FROM photo_versions WHERE photo_id = ${photoId}`;
    expect(v).toMatchObject({ gps_lat: -1.4, gps_lon: 35.1, gps_source: 'USER_DEFINED' });
    const hist = (await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits;
    expect(hist).toHaveLength(6);
    const title = hist.find((e: { field: string }) => e.field === 'title');
    expect(title).toMatchObject({ oldValue: 'IMG_0042', newValue: 'Lioness at dawn', oldSource: 'FOLDER_DERIVED', newSource: 'USER_DEFINED', kind: 'EDIT', undone: false });
    expect(new Set(hist.map((e: { batchId: string }) => e.batchId)).size).toBe(1);               // one save = one batch
    const d = (await A.json('GET', `/api/library/photos/${photoId}`)).body;
    expect(d).toMatchObject({ title: 'Lioness at dawn', titleSource: 'USER_DEFINED', description: 'A lioness watches the plain.', descriptionSource: 'USER_DEFINED', year: 2023, folderYear: 2024 });
  });

  it('is idempotent: saving the same values again records nothing; clearing a value clears its provenance', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua, { title: 'x' });
    await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'Same', notes: 'n' });
    const again = await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'Same', notes: 'n' });
    expect(again.body.changed).toEqual([]);
    expect((await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits).toHaveLength(2);
    await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: null, notes: '' });
    expect(await row(photoId)).toMatchObject({ title: null, title_source: null, notes: null });
  });

  it('confirming a folder-derived value as your own records the change of provenance', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua, { location: 'Kenya', year: 2024 });
    const r = await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { location: 'Kenya' });
    expect(r.body.changed).toEqual(['trip_location']);
    expect(await row(photoId)).toMatchObject({ trip_location: 'Kenya', trip_location_source: 'USER_DEFINED' });
  });

  it('undo restores the previous value AND provenance; undo is refused after a newer edit, twice, or on an undo', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua, { title: 'Folder name' });
    await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'First' });
    const [e1] = (await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits;
    await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'Second' });
    expect((await A.json('POST', `/api/library/photos/${photoId}/history/${e1.id}/undo`)).status).toBe(409);       // value changed since
    const [e2] = (await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits;
    expect((await A.json('POST', `/api/library/photos/${photoId}/history/${e2.id}/undo`)).status).toBe(200);
    expect(await row(photoId)).toMatchObject({ title: 'First', title_source: 'USER_DEFINED' });
    expect((await A.json('POST', `/api/library/photos/${photoId}/history/${e2.id}/undo`)).body.error).toBe('already_undone');
    const hist = (await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits;
    const undoRow = hist.find((e: { kind: string }) => e.kind === 'UNDO');
    expect(undoRow.revertsId).toBe(e2.id); expect((await A.json('POST', `/api/library/photos/${photoId}/history/${undoRow.id}/undo`)).body.error).toBe('is_undo');
    const e1b = hist.find((e: { id: string }) => e.id === e1.id);
    expect((await A.json('POST', `/api/library/photos/${photoId}/history/${e1b.id}/undo`)).status).toBe(200);
    expect(await row(photoId)).toMatchObject({ title: 'Folder name', title_source: 'FOLDER_DERIVED' });
  });

  it('validation: empty patches, unknown fields, over-long text, impossible coordinates and dates are refused', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua);
    for (const bad of [{}, { rating: 3 }, { title: 'x'.repeat(201) }, { gps: { lat: 91, lon: 0 } }, { gps: { lat: 0, lon: 181 } }, { captureAt: 'yesterday' }, { title: 5 }])
      expect((await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, bad)).status, JSON.stringify(bad)).toBe(400);
  });

  it('history is append-only at the database level', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua);
    await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'T' });
    await expect(h!.svc`UPDATE photo_edits SET new_value = '"x"' WHERE photo_id = ${photoId}`).rejects.toThrow(/append-only/);
    await expect(h!.svc`DELETE FROM photo_edits WHERE photo_id = ${photoId}`).rejects.toThrow(/append-only/);
    expect(await h!.app`SELECT 1 FROM photo_edits LIMIT 1`).toHaveLength(0);   // pv_app without a user context sees nothing (row-level security)
  });

  it('another user cannot read, edit, undo or see the history of my photograph (404), and edits never leak', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua, { title: 'mine' });
    await A.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'mine 2' });
    const [e] = (await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits;
    expect((await B.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'hijack' })).status).toBe(404);
    expect((await B.json('GET', `/api/library/photos/${photoId}/history`)).status).toBe(404);
    expect((await B.json('POST', `/api/library/photos/${photoId}/history/${e.id}/undo`)).status).toBe(404);
    expect((await B.json('GET', `/api/library/photos/${photoId}/versions`)).status).toBe(404);
    expect((await row(photoId)).title).toBe('mine 2');
    const anon = new ApiClient(app);
    expect((await anon.json('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'x' })).status).toBe(401);
    expect((await A.req('PATCH', `/api/library/photos/${photoId}/metadata`, { title: 'x' }, { csrf: false })).statusCode).toBe(403);
  });
});

describe('versions', () => {
  it('lists versions newest first and restores an earlier one; user data stays on the photograph', async (ctx) => {
    need(ctx);
    const { photoId, versionId, rootId } = await seedOne(h!.svc, ua, { title: 'Keep me', rating: 4 });
    const v2 = randomUUID();
    await h!.svc.begin(async (tx) => {
      await tx`UPDATE photo_versions SET state = 'SUPERSEDED' WHERE id = ${versionId}`;
      await tx`INSERT INTO photo_versions (id, user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, width, height, bytes, state) VALUES (${v2}, ${ua}, ${photoId}, 2, ${rootId}, 're-export.jpg', ${randomBytes(32)}, 6000, 4000, 8000000, 'ACTIVE')`;
      await tx`UPDATE photos SET current_version_id = ${v2} WHERE id = ${photoId}`;
    });
    const list = (await A.json('GET', `/api/library/photos/${photoId}/versions`)).body.versions;
    expect(list.map((v: { versionNo: number; current: boolean; state: string }) => [v.versionNo, v.current, v.state])).toEqual([[2, true, 'ACTIVE'], [1, false, 'SUPERSEDED']]);
    expect(list[0].sha256Prefix).toMatch(/^[0-9a-f]{12}$/);
    expect((await A.json('POST', `/api/library/photos/${photoId}/versions/${versionId}/restore`)).body.changed).toBe(true);
    const after = (await A.json('GET', `/api/library/photos/${photoId}/versions`)).body.versions;
    expect(after.map((v: { versionNo: number; current: boolean; state: string }) => [v.versionNo, v.current, v.state])).toEqual([[2, false, 'SUPERSEDED'], [1, true, 'ACTIVE']]);
    expect(await row(photoId)).toMatchObject({ title: 'Keep me', rating: 4, current_version_id: versionId });
    expect((await A.json('POST', `/api/library/photos/${photoId}/versions/${versionId}/restore`)).body.changed).toBe(false);
    const hist = (await A.json('GET', `/api/library/photos/${photoId}/history`)).body.edits;
    expect(hist[0]).toMatchObject({ field: 'current_version', kind: 'EDIT' });
    expect((await B.json('POST', `/api/library/photos/${photoId}/versions/${versionId}/restore`)).status).toBe(404);
    expect((await A.json('POST', `/api/library/photos/${photoId}/versions/${randomUUID()}/restore`)).status).toBe(404);
  });
});

describe('duplicates', () => {
  const flip = (h0: bigint, ...bits: number[]) => bits.reduce((x, b) => x ^ (1n << BigInt(b)), h0);
  it('finds near-duplicates by perceptual hash (multi-index), remembers decisions and never re-proposes DISTINCT pairs', async (ctx) => {
    need(ctx);
    const base = 0x1234_5678_9abc_def0n;
    const a = await seedOne(h!.svc, ub, { phash: base, title: 'orig' });
    const b = await seedOne(h!.svc, ub, { phash: flip(base, 3, 40), title: 'resized' });                // distance 2
    const c = await seedOne(h!.svc, ub, { phash: flip(base, 1, 9, 22, 35, 50, 60), title: 'cropped' });    // distance 6
    const d = await seedOne(h!.svc, ub, { phash: flip(base, 1, 9, 22, 35, 50, 60, 62, 10), title: 'far' }); // 8 from base: outside 6
    const e = await seedOne(h!.svc, ub, { phash: ~base, title: 'unrelated' });
    await seedOne(h!.svc, ub, { phash: null, title: 'no hash' });
    const s = (await B.json('POST', '/api/library/duplicates/scan', {})).body;
    expect(s.found).toBe(3);                                                                              // a–b (2), a–c (6) and c–d (2); b–c is 8 apart, a–d is 8 apart
    const open = (await B.json('GET', '/api/library/duplicates?state=OPEN&limit=100')).body;
    const key = (p: { a: { id: string }; b: { id: string } }) => [p.a.id, p.b.id].sort().join('|');
    const keys = new Set<string>(open.items.map(key));
    expect(keys.has([a.photoId, b.photoId].sort().join('|'))).toBe(true);
    expect(keys.has([a.photoId, c.photoId].sort().join('|'))).toBe(true);
    expect(keys.has([b.photoId, c.photoId].sort().join('|'))).toBe(false);
    expect(keys.has([a.photoId, d.photoId].sort().join('|'))).toBe(false);
    expect([...keys].some((k) => k.includes(e.photoId))).toBe(false);
    const ab = open.items.find((p: { a: { id: string }; b: { id: string } }) => key(p) === [a.photoId, b.photoId].sort().join('|'));
    expect(ab.distance).toBe(2); expect(open.items[0].distance).toBeLessThanOrEqual(open.items[open.items.length - 1].distance);   // most similar first
    // per photograph
    const forA = (await B.json('GET', `/api/library/photos/${a.photoId}/duplicates`)).body.pairs;
    expect(forA.map((p: { other: { title: string } }) => p.other.title).sort()).toEqual(['cropped', 'resized']);
    // library filter + card flag
    const dupList = (await B.json('GET', '/api/library/photos?dup=open&limit=100')).body;
    expect(dupList.items.every((i: { duplicateOpen: boolean }) => i.duplicateOpen)).toBe(true);
    expect(new Set(dupList.items.map((i: { id: string }) => i.id))).toEqual(new Set([a.photoId, b.photoId, c.photoId, d.photoId]));
    // decisions
    expect((await B.json('POST', `/api/library/duplicates/${ab.id}`, { state: 'DISTINCT' })).status).toBe(200);
    expect((await B.json('POST', '/api/library/duplicates/scan', {})).body.found).toBe(0);                // nothing new; DISTINCT stays DISTINCT
    const after = await h!.svc`SELECT state FROM duplicate_pairs WHERE id = ${ab.id}`;
    expect(after[0]!.state).toBe('DISTINCT');
    expect((await B.json('GET', `/api/library/photos/${a.photoId}/duplicates`)).body.pairs.map((p: { other: { title: string } }) => p.other.title)).toEqual(['cropped']);
    const bc = open.items.find((p: { a: { id: string }; b: { id: string } }) => key(p) === [a.photoId, c.photoId].sort().join('|'));
    expect((await B.json('POST', `/api/library/duplicates/${bc.id}`, { state: 'DUPLICATE' })).status).toBe(200);
    expect((await B.json('GET', '/api/library/duplicates?state=DUPLICATE')).body.total).toBe(1);
    expect((await B.json('POST', `/api/library/duplicates/${bc.id}`, { state: 'OPEN' })).status).toBe(200);
    expect((await h!.svc`SELECT decided_at FROM duplicate_pairs WHERE id = ${bc.id}`)[0]!.decided_at).toBeNull();
    expect((await B.json('POST', `/api/library/duplicates/${bc.id}`, { state: 'DELETE' })).status).toBe(400);
    // nothing was removed or hidden by any of this
    expect((await h!.svc`SELECT count(*)::int AS n FROM photos WHERE user_id = ${ub} AND NOT hidden AND deleted_at IS NULL`)[0]!.n).toBe(6);
  });
  it('pairs are private to their owner and the scan is bounded by the threshold', async (ctx) => {
    need(ctx);
    expect((await A.json('GET', '/api/library/duplicates?state=OPEN&limit=100')).body.items.every((p: { a: { id: string } }) => p.a.id)).toBe(true);
    const mine = (await A.json('GET', '/api/library/duplicates?state=OPEN')).body.items.map((p: { a: { id: string } }) => p.a.id);
    const theirs = (await B.json('GET', '/api/library/duplicates?state=OPEN')).body.items.map((p: { a: { id: string } }) => p.a.id);
    expect(mine.some((i: string) => theirs.includes(i))).toBe(false);
    expect((await A.json('POST', '/api/library/duplicates/scan', { maxDistance: 8 })).status).toBe(400);
    expect((await A.json('GET', '/api/library/duplicates?cursor=bad')).status).toBe(400);
  });
});

describe('comparison, hidden photographs and bulk location', () => {
  it('compare returns 2–4 photographs with full detail, in the requested order, only the caller’s own', async (ctx) => {
    need(ctx);
    const p1 = await seedOne(h!.svc, ua, { title: 'one', width: 6000, height: 4000 }), p2 = await seedOne(h!.svc, ua, { title: 'two', width: 4000, height: 6000 });
    const r = await A.json('GET', `/api/library/compare?ids=${p2.photoId},${p1.photoId}`);
    expect(r.status).toBe(200); expect(r.body.photos.map((p: { title: string }) => p.title)).toEqual(['two', 'one']);
    expect(r.body.photos[0]).toMatchObject({ width: 4000, height: 6000, orientation: 'portrait' });
    expect((await A.json('GET', `/api/library/compare?ids=${p1.photoId}`)).status).toBe(400);
    expect((await A.json('GET', `/api/library/compare?ids=${[1, 2, 3, 4, 5].map(() => randomUUID()).join(',')}`)).status).toBe(400);
    const mixed = await B.json('GET', `/api/library/compare?ids=${p1.photoId},${p2.photoId}`);
    expect(mixed.body.photos).toEqual([]);                                                                 // not B's photographs: nothing
  });
  it('hiding removes a photograph from the library and the Hidden filter brings it back; restoring is one call', async (ctx) => {
    need(ctx);
    const { photoId } = await seedOne(h!.svc, ua, { title: 'hide me' });
    expect((await A.json('PATCH', `/api/library/photos/${photoId}`, { hidden: true })).status).toBe(200);
    const all = (await A.json('GET', '/api/library/photos?limit=300')).body.items.map((i: { id: string }) => i.id);
    expect(all).not.toContain(photoId);
    const hid = (await A.json('GET', '/api/library/photos?hidden=true&limit=300')).body.items.map((i: { id: string }) => i.id);
    expect(hid).toContain(photoId); expect(hid).not.toContain(all[0]);
    expect((await A.json('POST', '/api/library/photos/bulk', { target: { ids: [photoId] }, set: { hidden: false } })).body.updated).toBe(1);
    expect((await A.json('GET', '/api/library/photos?limit=300')).body.items.map((i: { id: string }) => i.id)).toContain(photoId);
  });
  it('bulk location sets many at once, records each change, and respects ownership', async (ctx) => {
    need(ctx);
    const xs = [await seedOne(h!.svc, ua, { location: 'Old' }), await seedOne(h!.svc, ua, { location: null }), await seedOne(h!.svc, ua, { location: 'Kenya' })];
    const mine = (await seedOne(h!.svc, ub, { location: 'Theirs' })).photoId;
    const ids = [...xs.map((x) => x.photoId), mine];
    const r = await A.json('POST', '/api/library/photos/bulk-location', { target: { ids }, location: 'Kenya' });
    expect(r.body.updated).toBe(2);                                                                        // the one already 'Kenya' is unchanged; B's is not A's
    const rows = await h!.svc`SELECT id, trip_location, trip_location_source FROM photos WHERE id = ANY(${ids}::uuid[])`;
    for (const x of rows) { if (x.id === mine) expect(x.trip_location).toBe('Theirs'); else expect(x.trip_location).toBe('Kenya'); }
    const hist = await h!.svc`SELECT kind, old_value, new_value FROM photo_edits WHERE photo_id = ${xs[0]!.photoId}`;
    expect(hist).toHaveLength(1); expect(hist[0]).toMatchObject({ kind: 'BULK', old_value: 'Old', new_value: 'Kenya' });
    const q = await A.json('POST', '/api/library/photos/bulk-location', { target: { query: { view: 'all', location: ['Kenya'] }, exclude: [xs[0]!.photoId] }, location: null });
    expect(q.body.updated).toBeGreaterThanOrEqual(2);
    expect((await row(xs[0]!.photoId)).trip_location).toBe('Kenya');
    expect((await row(mine)).trip_location).toBe('Theirs');
    expect((await A.json('POST', '/api/library/photos/bulk-location', { target: { ids: [] }, location: 'x' })).status).toBe(400);
  });
});
