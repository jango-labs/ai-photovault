import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { makeJpeg } from '../ingest/testkit.js';
import { startMockRuntime, type MockRuntime } from './mock-runtime.js';
import { Publisher, GRACE_MS, LATE_MS } from './publisher.js';
import { HttpGraphPublisher } from './graph.js';
import { LocalTokenDelivery } from './delivery.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let ua: string; let rt: MockRuntime; let root: string, lib: string, deliveryDir: string;
let clock = new Date(); const now = () => clock;
const P = '/api/publishing';
const iso = (ms: number) => new Date(clock.getTime() + ms);

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-pub-')); lib = path.join(root, 'library'); deliveryDir = path.join(root, 'delivery'); fs.mkdirSync(lib);
  app = makeApp(h); ua = await makeUser(h.svc, 'a@example.test'); A = await new ApiClient(app).signIn('a@example.test');
  rt = await startMockRuntime({ service: h.svc, delivery: h.delivery, deliveryDir, now, sleep: async () => undefined });
  await h.svc`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, status) VALUES (${ua}, 'instagram', 'synthetic-pub', 'synthetic_archive', 'SYNTHETIC', 'DISCONNECTED')`;
}, 120_000);
afterAll(async () => { if (h) { await rt.stop(); await wipe(h.svc); await app.close(); await h.close(); fs.rmSync(root, { recursive: true, force: true }); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

let n = 0;
/** A photograph whose real file exists, an approved draft, and a schedule that is due `dueMs` ago (dueMs may be negative for "not yet"). */
async function post(o: { w?: number; h?: number; dueMs?: number; caption?: string; gps?: boolean } = {}) {
  const rel = `pub-${++n}-${randomUUID().slice(0, 6)}.jpg`; await makeJpeg(path.join(lib, rel), { width: o.w ?? 2000, height: o.h ?? 2500, pattern: n, make: 'Canon', model: 'EOS R5', ...(o.gps === false ? {} : { gps: { lat: -1.29, lon: 36.82 } }), iptc: { title: 'secret title', keywords: ['private'] } });
  const [r] = await h!.svc<{ id: string }[]>`INSERT INTO library_roots (user_id, path) VALUES (${ua}, ${lib}) ON CONFLICT (user_id, path) DO UPDATE SET path = excluded.path RETURNING id`;
  const s = await seedOne(h!.svc, ua, { title: `Pub ${n}`, relpath: rel, rootId: r!.id, width: o.w ?? 2000, height: o.h ?? 2500 });
  const d = (await A.json('POST', `${P}/drafts`, { photoId: s.photoId, caption: o.caption ?? `Caption ${n}`, hashtags: ['wildlife'] })).body;
  await A.json('POST', `${P}/drafts/${d.id}/ready`); await A.json('POST', `${P}/drafts/${d.id}/approve`, { acknowledgeHistory: true });
  const sch = (await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'UTC' })).body.schedule;
  await h!.svc`UPDATE scheduled_publications SET scheduled_at = ${iso(-(o.dueMs ?? 60_000))} WHERE id = ${sch.id}`;
  return { draftId: d.id as string, scheduleId: sch.id as string, photoId: s.photoId, text: `${o.caption ?? `Caption ${n}`}\n\n#wildlife` };
}
const row = async (id: string) => (await h!.svc`SELECT * FROM scheduled_publications WHERE id = ${id}`)[0]!;
const phases = async (id: string) => (await h!.svc`SELECT phase, outcome FROM publication_attempts WHERE scheduled_publication_id = ${id} ORDER BY started_at, id`).map((r) => `${r.phase}:${r.outcome}`);
const reset = () => { rt.graph.media.length = 0; rt.graph.containers.clear(); rt.graph.calls.length = 0; rt.graph.publishCalls = 0; };
const tick = (pub: Publisher = rt.publisher) => pub.tick(5);

describe('the publisher: the happy path, end to end through the real delivery service and the mock Graph server', () => {
  it('publishes a due, approved post once, verifies it, and records everything', async (ctx) => {
    need(ctx); reset();
    const p = await post(); const r = await tick();
    expect(r).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    const s = await row(p.scheduleId); expect(s).toMatchObject({ state: 'PUBLISHED', error_code: null, locked_by: null }); expect(s.verified_at).toBeTruthy(); expect(s.platform_post_id).toMatch(/^m_/); expect(s.permalink).toContain('mock.instagram.invalid'); expect(s.publish_requested_at).toBeTruthy();
    expect(rt.graph.media).toHaveLength(1); expect(rt.graph.publishCalls).toBe(1); expect(rt.graph.media[0]!.caption).toBe(p.text);
    // what Instagram's servers fetched: a JPEG within limits with NO metadata — the source had GPS, camera data and IPTC
    expect(rt.graph.media[0]!.imageInfo).toMatchObject({ format: 'jpeg', hasExif: false }); expect(rt.graph.media[0]!.imageInfo.width).toBeLessThanOrEqual(1440); expect(rt.graph.media[0]!.imageBytes).toBeGreaterThan(1000);
    expect(await phases(p.scheduleId)).toEqual(['PREFLIGHT:OK', 'PREFLIGHT:OK', 'CREATE_CONTAINER:OK', 'POLL_STATUS:OK', 'PUBLISH:OK', 'VERIFY:OK']);
    expect((await h!.svc`SELECT state FROM publishing_drafts WHERE id = ${p.draftId}`)[0]!.state).toBe('PUBLISHED');
    expect((await h!.svc`SELECT origin, raw FROM social_posts WHERE platform_post_id = ${s.platform_post_id}`)[0]).toMatchObject({ origin: 'APP_PUBLISHED', raw: { mock: true } });
    expect((await h!.svc`SELECT state, signals FROM photo_social_matches WHERE photo_id = ${p.photoId}`)[0]).toMatchObject({ state: 'EXACT_MATCH', signals: { published: true } });
    expect((await A.json('GET', `/api/library/photos/${p.photoId}`)).body.ig.state).toBe('POSTED');
    expect((await h!.svc`SELECT revoked_at FROM delivery_tokens WHERE scheduled_publication_id = ${p.scheduleId}`)[0]!.revoked_at).toBeTruthy(); expect(fs.readdirSync(deliveryDir)).toEqual([]);          // the temporary copy is gone
    expect((await A.json('GET', `${P}/drafts/${p.draftId}/attempts`)).body.items.map((a: { phase: string }) => a.phase)).toContain('VERIFY');
    expect((await tick())).toMatchObject({ claimed: 0 });                                                                                  // nothing left to do
  });
  it('the source file is never modified', async (ctx) => {
    need(ctx); reset();
    const p = await post(); const rel = (await h!.svc`SELECT v.source_relpath FROM photo_versions v JOIN publishing_drafts d ON d.photo_version_id = v.id WHERE d.id = ${p.draftId}`)[0]!.source_relpath as string;
    const before = fs.readFileSync(path.join(lib, rel)); await tick(); expect(fs.readFileSync(path.join(lib, rel)).equals(before)).toBe(true);
  });
});

describe('what is NOT published', () => {
  it('a post that is not yet due, or whose draft is no longer approved and scheduled', async (ctx) => {
    need(ctx); reset();
    const future = await post({ dueMs: -3_600_000 }); const unapproved = await post();
    await h!.svc`UPDATE publishing_drafts SET state = 'DRAFT', approved_at = NULL, approved_by = NULL WHERE id = ${unapproved.draftId}`;
    expect(await tick()).toMatchObject({ claimed: 0, published: 0 }); expect(rt.graph.calls).toHaveLength(0); expect((await row(future.scheduleId)).state).toBe('SCHEDULED'); expect((await row(unapproved.scheduleId)).state).toBe('SCHEDULED');
  });
  it('a post more than 15 minutes late is not published automatically: it fails as LATE and a person chooses a new time', async (ctx) => {
    need(ctx); reset();
    const p = await post({ dueMs: LATE_MS + 60_000 }); const r = await tick(); expect(r).toMatchObject({ late: 1, claimed: 0 });
    expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'LATE' }); expect(rt.graph.calls).toHaveLength(0);
    const again = await A.json('PATCH', `${P}/schedule/${p.scheduleId}`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }); expect(again.body.schedule).toMatchObject({ state: 'SCHEDULED', errorCode: null });
    await h!.svc`UPDATE scheduled_publications SET scheduled_at = ${iso(-60_000)} WHERE id = ${p.scheduleId}`; expect(await tick()).toMatchObject({ published: 1 });          // the person's retry works
  });
  it('a photograph outside Instagram’s aspect ratios fails before anything is sent', async (ctx) => {
    need(ctx); reset();
    const p = await post({ w: 1000, h: 4000 }); await tick(); expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'ASPECT_RATIO' }); expect(rt.graph.calls).toHaveLength(0);
    expect((await row(p.scheduleId)).error_message).toMatch(/4:5 and 1\.91:1/);
  });
  it('no account, or an account that is not the local mock: refused, nothing is contacted', async (ctx) => {
    need(ctx); reset();
    await h!.svc`UPDATE social_accounts SET external_id = 'real-123' WHERE user_id = ${ua}`; const real = await post(); await tick();
    expect(await row(real.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'MOCK_ONLY' }); expect(rt.graph.calls).toHaveLength(0);
    await h!.svc`DELETE FROM social_accounts WHERE user_id = ${ua}`; const none = await post(); await tick(); expect(await row(none.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'NO_ACCOUNT' });
    await h!.svc`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, status) VALUES (${ua}, 'instagram', 'synthetic-pub', 'synthetic_archive', 'SYNTHETIC', 'DISCONNECTED')`;
  });
  it('a missing photograph file fails clearly', async (ctx) => {
    need(ctx); reset();
    const p = await post(); const rel = (await h!.svc`SELECT v.source_relpath FROM photo_versions v JOIN publishing_drafts d ON d.photo_version_id = v.id WHERE d.id = ${p.draftId}`)[0]!.source_relpath as string; fs.rmSync(path.join(lib, rel));
    await tick(); expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'NO_IMAGE' });
  });
});

describe('failures are retried safely, and outcomes that are unknown are never "fixed" by posting again', () => {
  it('a server error before anything exists is retried with backoff, and the post is published exactly once', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('create', 'http500');
    expect(await tick()).toMatchObject({ retried: 1, published: 0 });
    const s = await row(p.scheduleId); expect(s).toMatchObject({ state: 'SCHEDULED', attempt_count: 1, error_code: 'TRANSIENT', container_id: null }); expect(new Date(s.next_attempt_at).getTime()).toBeGreaterThan(clock.getTime());
    expect(await tick()).toMatchObject({ claimed: 0 });                       // backoff respected
    clock = iso(61_000); expect(await tick()).toMatchObject({ published: 1 }); expect(rt.graph.media).toHaveLength(1); expect(rt.graph.publishCalls).toBe(1); expect((await row(p.scheduleId)).attempt_count).toBe(2);
  });
  it('rate limiting waits at least as long as Instagram asked; exhausting the attempts fails the post with a clear reason', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('create', 'rate_limit'); await tick(); const s = await row(p.scheduleId); expect(new Date(s.next_attempt_at).getTime() - clock.getTime()).toBeGreaterThanOrEqual(119_000);
    await h!.svc`UPDATE scheduled_publications SET attempt_count = 2, next_attempt_at = NULL, state = 'SCHEDULED' WHERE id = ${p.scheduleId}`; rt.graph.failNext('create', 'http500'); await tick();
    expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'RETRIES_EXHAUSTED' }); expect(rt.graph.publishCalls).toBe(0);
  });
  it('an expired token fails the post for good and marks the account EXPIRED', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('create', 'auth'); await tick();
    expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'AUTH' }); expect((await h!.svc`SELECT status FROM social_accounts WHERE user_id = ${ua}`)[0]!.status).toBe('EXPIRED');
    await h!.svc`UPDATE social_accounts SET status = 'DISCONNECTED' WHERE user_id = ${ua}`;
  });
  it('a container Instagram rejects fails the post permanently, and the temporary image copy is removed', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('create', 'container_error'); await tick();
    expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'CONTAINER_ERROR' }); expect(rt.graph.publishCalls).toBe(0); expect(fs.readdirSync(deliveryDir)).toEqual([]);
  });
  it('publish answered, but the read-back failed: the next run only verifies — it does not publish again', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('media', 'http500'); await tick();
    const s = await row(p.scheduleId); expect(s.platform_post_id).toMatch(/^m_/); expect(s.state).toBe('SCHEDULED'); expect(rt.graph.publishCalls).toBe(1);
    clock = iso(61_000); expect(await tick()).toMatchObject({ published: 1 }); expect(rt.graph.publishCalls).toBe(1); expect(rt.graph.media).toHaveLength(1); expect((await row(p.scheduleId)).state).toBe('PUBLISHED');
  });
  it('UNKNOWN OUTCOME, the post exists (response lost after the effect): reconciled by its exact caption — one post, no second publish', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('publish', 'drop_after_effect'); const r = await tick();
    expect(r).toMatchObject({ published: 1 }); expect(rt.graph.publishCalls).toBe(1); expect(rt.graph.media).toHaveLength(1); expect((await row(p.scheduleId)).state).toBe('PUBLISHED');
    expect(await phases(p.scheduleId)).toEqual(expect.arrayContaining(['PUBLISH:UNKNOWN', 'RECONCILE:OK', 'VERIFY:OK']));
  });
  it('UNKNOWN OUTCOME, nothing shows up: it waits, never republishes by itself, then hands the decision to a person', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('publish', 'drop_no_effect');
    expect(await tick()).toMatchObject({ published: 0, failed: 0 });                                   // pending
    expect(await row(p.scheduleId)).toMatchObject({ state: 'PUBLISHING', error_code: 'UNKNOWN_OUTCOME' });
    clock = iso(2 * 60_000); expect(await tick()).toMatchObject({ failed: 0 }); expect(rt.graph.publishCalls).toBe(1);        // still inside the grace window, still not republished
    clock = iso(GRACE_MS + 5 * 60_000); expect(await tick()).toMatchObject({ failed: 1 });
    expect(await row(p.scheduleId)).toMatchObject({ state: 'FAILED', error_code: 'UNKNOWN_OUTCOME' }); expect((await row(p.scheduleId)).error_message).toMatch(/Check your Instagram account/); expect(rt.graph.publishCalls).toBe(1); expect(rt.graph.media).toHaveLength(0);
    await tick(); await tick(); expect(rt.graph.publishCalls).toBe(1);                                  // however many times it runs
    // the person looked, it is not there, and chooses a new time: only then is a fresh post made (a fresh container too)
    expect((await A.json('PATCH', `${P}/schedule/${p.scheduleId}`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(200);
    await h!.svc`UPDATE scheduled_publications SET scheduled_at = ${iso(-60_000)} WHERE id = ${p.scheduleId}`; expect(await tick()).toMatchObject({ published: 1 }); expect(rt.graph.publishCalls).toBe(2); expect(rt.graph.media).toHaveLength(1);
  });
  it('a person retrying after an unknown outcome is protected from a duplicate: if the post turns out to exist it is adopted, not posted again', async (ctx) => {
    need(ctx); reset();
    const p = await post(); rt.graph.failNext('publish', 'drop_after_effect'); rt.graph.failNext('list', 'http500');            // the post exists, but reconciliation cannot see it right now
    expect(await tick()).toMatchObject({ published: 0 }); expect(await row(p.scheduleId)).toMatchObject({ state: 'PUBLISHING', error_code: 'UNKNOWN_OUTCOME' }); expect(rt.graph.media).toHaveLength(1);
    // a failed lookup never turns into a failure verdict, however late it is
    clock = iso(GRACE_MS + 5 * 60_000); rt.graph.failNext('list', 'http500'); expect(await tick()).toMatchObject({ failed: 0 }); expect((await row(p.scheduleId)).state).toBe('PUBLISHING');
    // suppose it had been declared unknown and the person (who did not look) asks to try again
    await h!.svc`UPDATE scheduled_publications SET state = 'FAILED', error_code = 'UNKNOWN_OUTCOME', locked_by = NULL, locked_until = NULL WHERE id = ${p.scheduleId}`;
    expect((await A.json('PATCH', `${P}/schedule/${p.scheduleId}`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(200);
    await h!.svc`UPDATE scheduled_publications SET scheduled_at = ${iso(-60_000)} WHERE id = ${p.scheduleId}`;
    expect(await tick()).toMatchObject({ published: 1 }); expect(rt.graph.publishCalls).toBe(1); expect(rt.graph.media).toHaveLength(1); expect((await row(p.scheduleId)).state).toBe('PUBLISHED');
  });
});

describe('leases and concurrency', () => {
  it('a worker that died mid-way (expired lease, nothing requested yet) is resumed once; a live lease is respected', async (ctx) => {
    need(ctx); reset();
    const dead = await post(); const live = await post();
    await h!.svc`UPDATE scheduled_publications SET state = 'PUBLISHING', locked_by = 'dead-worker', locked_until = ${iso(-60_000)}, attempt_count = 1 WHERE id = ${dead.scheduleId}`;
    await h!.svc`UPDATE scheduled_publications SET state = 'PUBLISHING', locked_by = 'live-worker', locked_until = ${iso(120_000)}, attempt_count = 1 WHERE id = ${live.scheduleId}`;
    expect(await tick()).toMatchObject({ published: 1 }); expect((await row(dead.scheduleId)).state).toBe('PUBLISHED'); expect(await row(live.scheduleId)).toMatchObject({ state: 'PUBLISHING', locked_by: 'live-worker' }); expect(rt.graph.media).toHaveLength(1);
    await h!.svc`UPDATE scheduled_publications SET state = 'CANCELLED' WHERE id = ${live.scheduleId}`;
  });
  it('two publishers running at once never publish the same post twice', async (ctx) => {
    need(ctx); reset();
    const posts = [await post(), await post(), await post()];
    const other = new Publisher({ sql: h!.svc, mock: true, now, sleep: async () => undefined, instance: 'second', graph: new HttpGraphPublisher({ baseUrl: rt.graph.baseUrl, igUserId: 'ig-mock', token: () => 'mock-token' }), delivery: new LocalTokenDelivery({ sql: h!.svc, dir: deliveryDir, baseUrl: rt.deliveryUrl, now }) });
    const [a, b] = await Promise.all([rt.publisher.tick(2), other.tick(2)]);
    expect(a.published + b.published).toBeGreaterThanOrEqual(2); await Promise.all([rt.publisher.tick(2), other.tick(2)]);
    expect(rt.graph.media).toHaveLength(3); expect(rt.graph.publishCalls).toBe(3); for (const p of posts) expect((await row(p.scheduleId)).state).toBe('PUBLISHED');
    expect(new Set(rt.graph.media.map((m) => m.id)).size).toBe(3);
  });
});

describe('the build cannot publish for real', () => {
  it('the Graph client refuses a non-loopback address unless told it is live — and nothing in the app says that', () => {
    expect(() => new HttpGraphPublisher({ baseUrl: 'https://graph.instagram.com/v21.0', igUserId: 'x', token: () => 't' })).toThrow(/disabled in this build/);
    expect(() => new HttpGraphPublisher({ baseUrl: 'http://127.0.0.1:1/v1', igUserId: 'x', token: () => 't' })).not.toThrow();
    const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const src = walk(dir).filter((f) => f.endsWith('.ts') && !/\.(test|itest)\.ts$/.test(f));
    const uses = src.filter((f) => /new HttpGraphPublisher\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(dir, f)).sort(); expect(uses).toEqual(['publishing/graph.ts'.replace('graph.ts', 'mock-runtime.ts')]);
    for (const f of src) expect(fs.readFileSync(f, 'utf8'), path.relative(dir, f)).not.toMatch(/live:\s*true/);
    for (const f of src.filter((x) => /new PresignedUrlDelivery\(/.test(fs.readFileSync(x, 'utf8')))) throw new Error(`${f} constructs a cloud delivery provider`);
  });
  it('nothing the API can do causes a publish: scheduling and cancelling leave Instagram untouched', async (ctx) => {
    need(ctx); reset();
    const p = await post({ dueMs: -3_600_000 }); await A.json('POST', `${P}/schedule/${p.scheduleId}/cancel`); await A.json('POST', `${P}/drafts/${p.draftId}/cancel`);
    expect(rt.graph.calls).toHaveLength(0);
  });
});
