import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint } from '../ingest/hash.js';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { JobWorker, PermanentJobError } from '../jobs/worker.js';
import { LOCAL_EMBEDDING_DIMS, embedFile, toVectorLiteral } from '../search/embedding.js';
import { InstagramSync, instagramHandlers } from './sync.js';
import { RateLimited, TokenExpired, type InstagramProvider } from './provider.js';
import { kindOf } from './synthetic.js';

const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../web/public/fixtures');
let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let ua: string, ub: string;
let root: string, media: string, deriv: string;
const photos: Array<{ photoId: string; versionId: string; title: string; n: number }> = [];

async function addPhoto(user: string, n: number, fixture: string) {
  const fp = await fingerprint(path.join(FIX, `${fixture}.jpg`)); const emb = await embedFile(path.join(FIX, `${fixture}.jpg`));
  const s = await seedOne(h!.svc, user, { title: `Fixture ${String(n).padStart(2, '0')}`, location: 'Kenya', year: 2024, captureAt: new Date(Date.UTC(2024, 0, 1 + n)), phash: fp.phash });
  await h!.svc`UPDATE photo_versions SET dhash = ${fp.dhash.toString()}::bigint, deriv_status = 'READY' WHERE id = ${s.versionId}`;
  await h!.svc`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${user}, ${s.versionId}, 'local-visual-v1', 'image', ${LOCAL_EMBEDDING_DIMS}, ${toVectorLiteral(emb)}::halfvec)`;
  fs.mkdirSync(path.join(deriv, s.versionId), { recursive: true }); fs.copyFileSync(path.join(FIX, `${fixture}.jpg`), path.join(deriv, s.versionId, 'view.jpg'));
  return { ...s, title: `Fixture ${String(n).padStart(2, '0')}`, n };
}
const worker = () => new JobWorker(h!.svc, instagramHandlers(h!.svc, media), { backoffBaseSeconds: 0 });
const history = async (c: ApiClient, q = '') => (await c.json('GET', `/api/instagram/history?limit=200${q}`)).body;
const indexOfPost = (caption: string) => Number(/synthetic caption (\d+)/.exec(caption)![1]) - 1;

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ig-')); media = path.join(root, 'ig'); deriv = path.join(root, 'deriv'); fs.mkdirSync(media); fs.mkdirSync(deriv);
  app = makeApp(h, { derivativesDir: deriv, igMediaDir: media, syntheticMedia: true });
  ua = await makeUser(h.svc, 'a@example.test'); ub = await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
  const ids: string[] = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8')).map((f: { id: string }) => f.id);
  for (let i = 0; i < 20; i++) photos.push(await addPhoto(ua, i, ids[i]!));
  await addPhoto(ub, 1, ids[1]!);                                                         // another account owns a picture identical to one of mine
}, 120_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); fs.rmSync(root, { recursive: true, force: true }); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('synthetic archive → sync → match', () => {
  it('builds an archive from the library, syncs it through the worker, and proposes matches', async (ctx) => {
    need(ctx);
    expect((await A.json('GET', '/api/instagram/account')).body).toMatchObject({ account: null, capabilities: { synthetic: true, live: false } });
    const c = await A.json('POST', '/api/instagram/synthetic', { count: 20 }); expect(c.status).toBe(201); expect(c.body.archive).toMatchObject({ posts: 20, faithful: 12, cropped: 4, edited: 2, unrelated: 2 }); expect(c.body.queued).toBe(true);
    expect((await A.json('GET', '/api/instagram/account')).body.syncing).toBe(true);
    expect(await worker().drain()).toBeGreaterThanOrEqual(1);
    const a = (await A.json('GET', '/api/instagram/account')).body;
    expect(a.account).toMatchObject({ synthetic: true, status: 'DISCONNECTED', username: 'synthetic_archive' }); expect(a.syncing).toBe(false); expect(a.lastRun).toMatchObject({ status: 'OK', postsSeen: 20, postsNew: 20, mediaFailed: 0 });
    expect(a.stats.posts).toBe(20); expect(JSON.stringify(a)).not.toMatch(/token|ciphertext/i);
  });

  it('every faithful re-export is matched with high confidence to the right photograph; unrelated posts match nothing; nothing is auto-confirmed', async (ctx) => {
    need(ctx);
    const items = (await history(A)).items as Array<{ caption: string; match: { state: string; photoTitle: string } | null }>; expect(items).toHaveLength(20);
    let faithful = 0, unrelated = 0, other = 0, otherRight = 0;
    for (const it of items) {
      const i = indexOfPost(it.caption); const kind = kindOf(i); const title = /^(Fixture \d+)/.exec(it.caption)![1]!;
      if (kind === 'faithful') { faithful++; expect(it.match, it.caption).toMatchObject({ state: 'HIGH_CONFIDENCE_MATCH', photoTitle: title }); }
      else if (kind === 'unrelated') { unrelated++; expect(it.match, it.caption).toBeNull(); }
      else { other++; if (it.match?.photoTitle === title) otherRight++; if (it.match) expect(['POSSIBLE_MATCH', 'HIGH_CONFIDENCE_MATCH']).toContain(it.match.state); }
    }
    expect([faithful, unrelated, other]).toEqual([12, 2, 6]); expect(otherRight, 'edited and cropped copies find their photograph').toBeGreaterThanOrEqual(4);
    expect((await h!.svc`SELECT count(*)::int AS n FROM photo_social_matches WHERE state = 'USER_CONFIRMED'`)[0]!.n).toBe(0);
    expect((await h!.svc`SELECT count(*)::int AS n FROM photo_social_matches WHERE user_id = ${ub}`)[0]!.n).toBe(0);               // the other account's identical picture was never touched
  });

  it('syncing again changes nothing: no new posts, no downloads, no duplicate matches', async (ctx) => {
    need(ctx);
    const before = (await h!.svc`SELECT (SELECT count(*)::int FROM social_posts) AS p, (SELECT count(*)::int FROM social_post_media) AS m, (SELECT count(*)::int FROM photo_social_matches) AS x`)[0]!;
    expect((await A.json('POST', '/api/instagram/sync')).body.queued).toBe(true); await worker().drain();
    expect((await h!.svc`SELECT (SELECT count(*)::int FROM social_posts) AS p, (SELECT count(*)::int FROM social_post_media) AS m, (SELECT count(*)::int FROM photo_social_matches) AS x`)[0]).toEqual(before);
    expect((await A.json('GET', '/api/instagram/account')).body.lastRun).toMatchObject({ status: 'OK', postsSeen: 20, postsNew: 0, matched: 0 });
  });

  it('library photographs now know they were posted (and the Library filter agrees)', async (ctx) => {
    need(ctx);
    const posted = (await A.json('GET', '/api/library/photos?ig=posted&limit=100')).body; expect(posted.total).toBeGreaterThanOrEqual(12);
    expect(posted.items.every((p: { ig: { state: string } }) => p.ig.state === 'POSTED')).toBe(true);
    expect((await A.json('GET', '/api/library/photos?ig=never&limit=100')).body.total + posted.total).toBe(20);
  });
});

describe('review and decisions', () => {
  it('the review queue lists the best candidate per image, most promising first, with both pictures and the signals', async (ctx) => {
    need(ctx);
    const r = (await A.json('GET', '/api/instagram/review')).body; expect(r.total).toBeGreaterThanOrEqual(2); expect(r.items.length).toBe(Math.min(r.total, 20));
    const scores = r.items.map((i: { score: number }) => i.score); expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(r.items[0]).toMatchObject({ post: { mediaId: expect.any(String), caption: expect.stringContaining('synthetic') }, photo: { id: expect.any(String), title: expect.stringMatching(/^Fixture/) }, signals: expect.objectContaining({ sameBytes: false }) });
    expect(new Set(r.items.map((i: { post: { mediaId: string } }) => i.post.mediaId)).size).toBe(r.items.length);
    expect((await A.json('GET', '/api/instagram/review?limit=51')).status).toBe(400);
  });

  it('confirming records a person’s decision, withdraws the system’s other proposals for that image, and marks the photograph as posted', async (ctx) => {
    need(ctx);
    const r = (await A.json('GET', '/api/instagram/review')).body; const it = r.items[0];
    expect((await A.json('POST', `/api/instagram/matches/${it.matchId}`, { decision: 'confirm' })).status).toBe(200);
    const [m] = await h!.svc`SELECT state, decided_by, decided_at FROM photo_social_matches WHERE id = ${it.matchId}`; expect(m).toMatchObject({ state: 'USER_CONFIRMED', decided_by: 'USER' }); expect(m!.decided_at).toBeTruthy();
    expect((await h!.svc`SELECT count(*)::int AS n FROM photo_social_matches WHERE social_post_media_id = ${it.post.mediaId} AND id <> ${it.matchId} AND state IN ('POSSIBLE_MATCH','HIGH_CONFIDENCE_MATCH','EXACT_MATCH')`)[0]!.n).toBe(0);
    expect((await A.json('GET', `/api/library/photos/${it.photo.id}`)).body.ig.state).toBe('POSTED');
    expect((await A.json('GET', '/api/instagram/review')).body.items.map((x: { matchId: string }) => x.matchId)).not.toContain(it.matchId);
  });

  it('rejecting is remembered: the pair is never proposed again, not even by a full re-match', async (ctx) => {
    need(ctx);
    const r = (await A.json('GET', '/api/instagram/review')).body; const it = r.items[0]; expect(it).toBeTruthy();
    expect((await A.json('POST', `/api/instagram/matches/${it.matchId}`, { decision: 'reject' })).status).toBe(200);
    expect((await h!.svc`SELECT state FROM photo_social_matches WHERE id = ${it.matchId}`)[0]!.state).toBe('USER_REJECTED');
    expect((await A.json('POST', '/api/instagram/rematch')).body.queued).toBe(true); await worker().drain();
    expect((await h!.svc`SELECT state FROM photo_social_matches WHERE id = ${it.matchId}`)[0]!.state).toBe('USER_REJECTED');
    expect((await A.json('GET', '/api/instagram/review')).body.items.map((x: { matchId: string }) => x.matchId)).not.toContain(it.matchId);
    expect((await h!.svc`SELECT count(*)::int AS n FROM photo_social_matches p WHERE p.state = 'POSSIBLE_MATCH' AND EXISTS (SELECT 1 FROM photo_social_matches s WHERE s.social_post_media_id = p.social_post_media_id AND s.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED'))`)[0]!.n).toBe(0);      // no weaker proposal next to a strong or human answer
    expect((await A.json('POST', `/api/instagram/matches/${it.matchId}`, { decision: 'confirm' })).status).toBe(200);          // a person can change their mind
    expect((await h!.svc`SELECT state FROM photo_social_matches WHERE id = ${it.matchId}`)[0]!.state).toBe('USER_CONFIRMED');
  });

  it('an unmatched post can be linked to a photograph by hand', async (ctx) => {
    need(ctx);
    const un = ((await history(A, '&filter=unmatched')).items as Array<{ id: string; mediaId: string }>)[0]!; expect(un).toBeTruthy();
    const target = photos[19]!;
    expect((await A.json('POST', `/api/instagram/media/${un.mediaId}/link`, { photoId: target.photoId })).status).toBe(200);
    const [m] = await h!.svc`SELECT state, decided_by, signals FROM photo_social_matches WHERE social_post_media_id = ${un.mediaId} AND photo_id = ${target.photoId}`; expect(m).toMatchObject({ state: 'USER_CONFIRMED', decided_by: 'USER', signals: { manual: true } });
    expect(((await history(A, '&filter=matched')).items as Array<{ id: string }>).map((x) => x.id)).toContain(un.id);
    expect((await A.json('POST', `/api/instagram/media/${un.mediaId}/link`, { photoId: randomUUID() })).status).toBe(404);
  });

  it('history filters and counts agree with each other', async (ctx) => {
    need(ctx);
    const all = await history(A); const sum = all.counts.matched + all.counts.review + all.counts.unmatched; expect(sum).toBe(all.counts.all);
    for (const f of ['matched', 'review', 'unmatched'] as const) expect((await history(A, `&filter=${f}`)).items.length, f).toBe(all.counts[f]);
    const p1 = (await A.json('GET', '/api/instagram/history?limit=7')).body; const p2 = (await A.json('GET', `/api/instagram/history?limit=7&cursor=${p1.nextCursor}`)).body; const p3 = (await A.json('GET', `/api/instagram/history?limit=7&cursor=${p2.nextCursor}`)).body;
    expect([...p1.items, ...p2.items, ...p3.items].map((x: { id: string }) => x.id)).toEqual(all.items.map((x: { id: string }) => x.id)); expect(p3.nextCursor).toBeNull();
    const dates = all.items.map((x: { postedAt: string }) => x.postedAt); expect(dates).toEqual([...dates].sort().reverse());
    expect((await A.json('GET', '/api/instagram/history?cursor=garbage')).status).toBe(400); expect((await A.json('GET', '/api/instagram/history?filter=bogus')).status).toBe(400);
  });
});

describe('duplicate-post warning data', () => {
  it('"same": a photograph with a confirmed or high-confidence post, with the latest post; "none": a photograph never posted', async (ctx) => {
    need(ctx);
    const posted = ((await A.json('GET', '/api/library/photos?ig=posted&limit=5')).body.items as Array<{ id: string }>)[0]!;
    const same = (await A.json('GET', `/api/instagram/posted-check?photoId=${posted.id}`)).body; expect(same).toMatchObject({ kind: 'same', count: expect.any(Number), last: { postId: expect.any(String), caption: expect.stringContaining('synthetic') } });
    const never = ((await A.json('GET', '/api/library/photos?ig=never&limit=50')).body.items as Array<{ id: string }>);
    const kinds = new Set<string>(); for (const p of never) kinds.add((await A.json('GET', `/api/instagram/posted-check?photoId=${p.id}`)).body.kind);
    expect(kinds.has('none') || kinds.has('similar')).toBe(true); for (const k of kinds) expect(['none', 'similar']).toContain(k);
  });
  it('"similar": an unconfirmed look-alike post is reported as similar; a pair a person rejected is not', async (ctx) => {
    need(ctx);
    // pick a post that is a faithful re-export of one of my photographs (which one depends on random ids, so look it up), then import the same picture again as a new photograph
    const hi = ((await history(A)).items as Array<{ match: { state: string; photoId: string } | null }>).find((i) => i.match?.state === 'HIGH_CONFIDENCE_MATCH')!; expect(hi).toBeTruthy();
    const ids: string[] = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8')).map((f: { id: string }) => f.id);
    const fresh = await addPhoto(ua, 40, ids[photos.find((p) => p.photoId === hi.match!.photoId)!.n]!);
    const r = (await A.json('GET', `/api/instagram/posted-check?photoId=${fresh.photoId}`)).body; expect(r.kind).toBe('similar'); expect(r.last.postId).toBeTruthy();
    expect((await A.json('GET', `/api/instagram/posted-check?photoId=${randomUUID()}`)).status).toBe(404); expect((await A.json('GET', '/api/instagram/posted-check?photoId=x')).status).toBe(400);
  });
});

describe('images, accounts and access', () => {
  it('serves a post’s image to its owner only', async (ctx) => {
    need(ctx);
    const mediaId = ((await history(A)).items as Array<{ mediaId: string }>)[0]!.mediaId;
    const ok = await A.req('GET', `/api/instagram/media/${mediaId}/image`); expect(ok.statusCode).toBe(200); expect(ok.headers['content-type']).toBe('image/jpeg'); expect(ok.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect((await B.req('GET', `/api/instagram/media/${mediaId}/image`)).statusCode).toBe(404); expect((await new ApiClient(app).req('GET', `/api/instagram/media/${mediaId}/image`)).statusCode).toBe(401);
    expect((await A.req('GET', `/api/instagram/media/${randomUUID()}/image`)).statusCode).toBe(404);
  });
  it('another account sees none of it and cannot decide, link or sync anything of mine', async (ctx) => {
    need(ctx);
    expect((await B.json('GET', '/api/instagram/account')).body).toMatchObject({ account: null, stats: { posts: 0 } }); expect((await history(B)).items).toEqual([]); expect((await B.json('GET', '/api/instagram/review')).body).toMatchObject({ total: 0, items: [] });
    const [m] = await h!.svc`SELECT id, social_post_media_id FROM photo_social_matches WHERE user_id = ${ua} LIMIT 1`;
    expect((await B.json('POST', `/api/instagram/matches/${m!.id}`, { decision: 'reject' })).status).toBe(404); expect((await B.json('POST', `/api/instagram/media/${m!.social_post_media_id}/link`, { photoId: photos[0]!.photoId })).status).toBe(404);
    expect((await B.json('POST', '/api/instagram/sync')).status).toBe(404);
  });
  it('every route needs a session; writes need the CSRF token; inputs are validated', async (ctx) => {
    need(ctx);
    const anon = new ApiClient(app); const id = randomUUID();
    for (const [m, u] of [['GET', '/api/instagram/account'], ['POST', '/api/instagram/synthetic'], ['POST', '/api/instagram/sync'], ['POST', '/api/instagram/rematch'], ['GET', '/api/instagram/history'], ['GET', '/api/instagram/review'], ['POST', `/api/instagram/matches/${id}`], ['POST', `/api/instagram/media/${id}/link`], ['GET', `/api/instagram/posted-check?photoId=${id}`]] as const)
      expect((await anon.json(m, u, m === 'POST' ? {} : undefined)).status, `${m} ${u}`).toBe(401);
    expect((await A.req('POST', '/api/instagram/sync', undefined, { csrf: false })).statusCode).toBe(403);
    expect((await A.json('POST', `/api/instagram/matches/${id}`, { decision: 'maybe' })).status).toBe(400); expect((await A.json('POST', `/api/instagram/matches/${id}`, { decision: 'confirm', extra: 1 })).status).toBe(400); expect((await A.json('POST', '/api/instagram/matches/x', { decision: 'confirm' })).status).toBe(400);
    expect((await A.json('POST', '/api/instagram/synthetic', { count: 0 })).status).toBe(400); expect((await A.json('POST', '/api/instagram/synthetic', { count: 301 })).status).toBe(400);
  });
  it('a production-style app (no synthetic media) refuses to build a synthetic archive', async (ctx) => {
    need(ctx);
    const prod = makeApp(h!, { derivativesDir: deriv, igMediaDir: media, syntheticMedia: false }); const P = new ApiClient(prod); P.jar = new Map(B.jar); P.csrf = B.csrf;                     // same session, different app configuration
    expect((await P.json('POST', '/api/instagram/synthetic', {})).status).toBe(403); expect((await P.json('GET', '/api/instagram/account')).body.capabilities).toEqual({ synthetic: false, live: false }); await prod.close();
  });
});

describe('failure and recovery', () => {
  const insertAccount = async (external: string) => (await h!.svc<{ id: string }[]>`INSERT INTO social_accounts (user_id, platform, external_id, username, status) VALUES (${ub}, 'instagram', ${external}, 'x', 'DISCONNECTED') RETURNING id`)[0]!.id;
  const provider = (kind: 'mock' | 'graph', listPosts: InstagramProvider['listPosts']): InstagramProvider => ({ kind, listPosts, fetchMedia: async () => { throw new Error('unused'); } });

  it('one unreadable image does not stop the sync: the run is PARTIAL, the rest is in, and the next sync retries only the failed image', async (ctx) => {
    need(ctx);
    const dir = path.join(media, 'synthetic', ua); const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    await h!.svc`DELETE FROM social_posts WHERE user_id = ${ua}`;                                              // start the account's history from scratch
    const good = fs.readFileSync(path.join(dir, 'img', '0.jpg')); fs.writeFileSync(path.join(dir, 'img', '0.jpg'), 'not an image');
    const acct = (await h!.svc<{ id: string }[]>`SELECT id FROM social_accounts WHERE user_id = ${ua}`)[0]!.id;
    const res = await new InstagramSync(h!.svc, media).sync(ua, acct, new (await import('./provider.js')).MockInstagramProvider(dir));
    expect(res).toMatchObject({ status: 'PARTIAL', postsSeen: 20, postsNew: 20, mediaFailed: 1, mediaFetched: 19 }); expect(man.posts).toHaveLength(20);
    expect((await h!.svc`SELECT count(*)::int AS n FROM social_post_media WHERE user_id = ${ua} AND fetched_at IS NULL`)[0]!.n).toBe(1);
    fs.writeFileSync(path.join(dir, 'img', '0.jpg'), good);
    const again = await new InstagramSync(h!.svc, media).sync(ua, acct, new (await import('./provider.js')).MockInstagramProvider(dir));
    expect(again).toMatchObject({ status: 'OK', postsNew: 0, mediaFetched: 1, mediaFailed: 0 }); expect((await h!.svc`SELECT count(*)::int AS n FROM social_post_media WHERE user_id = ${ua} AND fetched_at IS NULL`)[0]!.n).toBe(0);
  });
  it('an expired token marks the account EXPIRED and fails the job for good; a rate limit is retried later', async (ctx) => {
    need(ctx);
    const acct = await insertAccount('real-ig-1'); const sync = new InstagramSync(h!.svc, media);
    await expect(sync.sync(ub, acct, provider('graph', async () => { throw new TokenExpired(); }))).rejects.toBeInstanceOf(PermanentJobError);
    expect((await h!.svc`SELECT status, last_error FROM social_accounts WHERE id = ${acct}`)[0]).toMatchObject({ status: 'EXPIRED', last_error: expect.stringContaining('expired') });
    expect((await h!.svc`SELECT status FROM ig_sync_runs WHERE social_account_id = ${acct}`)[0]!.status).toBe('FAILED');
    const err = await sync.sync(ub, acct, provider('graph', async () => { throw new RateLimited(60); })).catch((e) => e); expect(err).toBeInstanceOf(RateLimited); expect(err).not.toBeInstanceOf(PermanentJobError);
  });
  it('a real account is closed unless a Meta app AND your approval are configured: the job handler refuses a non-synthetic account otherwise, and providers cannot be mixed up', async (ctx) => {
    need(ctx);
    const acct = await insertAccount('real-ig-2'); const handlers = instagramHandlers(h!.svc, media);
    await expect(handlers['ig.sync']!({ id: 'j', user_id: ub, kind: 'ig.sync', payload: { accountId: acct }, attempts: 1, max_attempts: 3 })).rejects.toThrow(/needs a Meta app and your approval/);
    await expect(handlers['ig.sync']!({ id: 'j', user_id: ub, kind: 'ig.sync', payload: { accountId: 'nope' }, attempts: 1, max_attempts: 3 })).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handlers['ig.sync']!({ id: 'j', user_id: ua, kind: 'ig.sync', payload: { accountId: acct }, attempts: 1, max_attempts: 3 })).rejects.toThrow(/No such Instagram account/);       // another user's account id
    const sync = new InstagramSync(h!.svc, media);
    await expect(sync.sync(ub, acct, provider('mock', async () => ({ posts: [], next: null })))).rejects.toThrow(/synthetic account/);
    const synthetic = await insertAccount('synthetic-zzz'); await expect(sync.sync(ub, synthetic, provider('graph', async () => ({ posts: [], next: null })))).rejects.toThrow(/never synced from Instagram/);
  });
  it('the sync never writes to Instagram or to the library: photograph rows are unchanged by a sync', async (ctx) => {
    need(ctx);
    const before = JSON.stringify(await h!.svc`SELECT id, title, rating, favorite, current_version_id, updated_at FROM photos WHERE user_id = ${ua} ORDER BY id`);
    await A.json('POST', '/api/instagram/sync'); await worker().drain();
    expect(JSON.stringify(await h!.svc`SELECT id, title, rating, favorite, current_version_id, updated_at FROM photos WHERE user_id = ${ua} ORDER BY id`)).toBe(before);
  });
});
