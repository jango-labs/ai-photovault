import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let ua: string;
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); app = makeApp(h);
  ua = await makeUser(h.svc, 'a@example.test'); await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const P = '/api/publishing';
const photo = async (user = ua, o: Parameters<typeof seedOne>[2] = {}) => (await seedOne(h!.svc, user, { title: 'Pub', ...o })).photoId;
const future = (mins = 120) => new Date(Date.now() + mins * 60_000).toISOString();
const draft = async (c: ApiClient, photoId: string, caption = 'A caption', hashtags: string[] = ['wildlife']) => (await c.json('POST', `${P}/drafts`, { photoId, caption, hashtags })).body;
const ready = async (c: ApiClient, id: string) => c.json('POST', `${P}/drafts/${id}/ready`);
const full = async (c: ApiClient, photoId: string, atMin = 120) => {
  const d = await draft(c, photoId); await ready(c, d.id); await c.json('POST', `${P}/drafts/${d.id}/approve`, { acknowledgeHistory: true });
  return (await c.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(atMin), timezone: 'Europe/London' })).body;
};

describe('drafts', () => {
  it('create → edit → ready: stores exact words, tags are cleaned, versions of the caption are kept', async (ctx) => {
    need(ctx);
    const p = await photo(); const r = await A.json('POST', `${P}/drafts`, { photoId: p, caption: 'First words', hashtags: ['#Lion', 'lion', 'Mara_2024'], title: 'Mara' });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ state: 'DRAFT', caption: 'First words', hashtags: ['Lion', 'Mara_2024'], title: 'Mara', approvedAt: null, schedule: null, photo: { id: p } });
    const u = await A.json('PATCH', `${P}/drafts/${r.body.id}`, { caption: 'Better words', origin: 'AI_EDITED', style: 'SHORT', model: 'local-template-v1' }); expect(u.body.caption).toBe('Better words');
    const full = (await A.json('GET', `${P}/drafts/${r.body.id}`)).body; expect(full.captionVersions.map((v: { body: string; origin: string }) => [v.body, v.origin])).toEqual([['Better words', 'AI_EDITED'], ['First words', 'USER']]);
    expect((await ready(A, r.body.id)).body.state).toBe('READY');
  });
  it('validates: unknown photograph, long text, bad hashtags, more than 30, empty patch, unknown fields', async (ctx) => {
    need(ctx);
    const p = await photo();
    expect((await A.json('POST', `${P}/drafts`, { photoId: randomUUID() })).status).toBe(404); expect((await B.json('POST', `${P}/drafts`, { photoId: p })).status).toBe(404);
    expect((await A.json('POST', `${P}/drafts`, { photoId: p, caption: 'x'.repeat(2201) })).status).toBe(400);
    expect((await A.json('POST', `${P}/drafts`, { photoId: p, caption: 'x'.repeat(2190), hashtags: ['abcdefghij'] })).status).toBe(400);           // together they exceed 2,200
    expect((await A.json('POST', `${P}/drafts`, { photoId: p, hashtags: ['has space'] })).status).toBe(400); expect((await A.json('POST', `${P}/drafts`, { photoId: p, hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).status).toBe(400);
    const d = await draft(A, p); expect((await A.json('PATCH', `${P}/drafts/${d.id}`, {})).status).toBe(400); expect((await A.json('PATCH', `${P}/drafts/${d.id}`, { state: 'PUBLISHED' })).status).toBe(400);
  });
  it('an empty caption cannot be marked ready', async (ctx) => {
    need(ctx);
    const d = await draft(A, await photo(), ''); const r = await ready(A, d.id); expect(r.status).toBe(400); expect(r.body.message).toMatch(/caption/i);
  });
  it('lists by state with keyset paging; another account sees nothing', async (ctx) => {
    need(ctx);
    const p = await photo(); for (let i = 0; i < 5; i++) await draft(A, p, `list ${i}`);
    const a = (await A.json('GET', `${P}/drafts?state=DRAFT&limit=2`)).body; expect(a.items).toHaveLength(2); expect(a.nextCursor).toBeTruthy();
    const b = (await A.json('GET', `${P}/drafts?state=DRAFT&limit=2&cursor=${a.nextCursor}`)).body; expect(b.items.map((x: { id: string }) => x.id)).not.toContain(a.items[0].id);
    expect((await B.json('GET', `${P}/drafts`)).body.items).toEqual([]); expect((await A.json('GET', `${P}/drafts?state=BOGUS`)).status).toBe(400); expect((await A.json('GET', `${P}/drafts?cursor=zz`)).status).toBe(400);
  });
});

describe('approval and scheduling gates', () => {
  it('cannot approve before ready, schedule before approval, or approve/schedule another account’s draft', async (ctx) => {
    need(ctx);
    const d = await draft(A, await photo());
    expect((await A.json('POST', `${P}/drafts/${d.id}/approve`, {})).status).toBe(409); expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(), timezone: 'UTC' })).status).toBe(409);
    await ready(A, d.id); expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(), timezone: 'UTC' })).body.message).toMatch(/approve/i);
    for (const a of ['ready', 'approve', 'schedule', 'cancel']) expect((await B.json('POST', `${P}/drafts/${d.id}/${a}`, a === 'schedule' ? { scheduledAt: future(), timezone: 'UTC' } : {})).status, a).toBe(404);
  });
  it('approving records who and when; the exact words are what was approved — editing withdraws the approval', async (ctx) => {
    need(ctx);
    const d = await draft(A, await photo()); await ready(A, d.id);
    const ap = (await A.json('POST', `${P}/drafts/${d.id}/approve`, {})).body; expect(ap.approvedAt).toBeTruthy(); expect((await h!.svc`SELECT approved_by FROM publishing_drafts WHERE id = ${d.id}`)[0]!.approved_by).toBe(ua);
    const ed = (await A.json('PATCH', `${P}/drafts/${d.id}`, { caption: 'Changed after approval' })).body; expect(ed).toMatchObject({ state: 'DRAFT', approvedAt: null });
    expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(), timezone: 'UTC' })).status).toBe(409);
    await ready(A, d.id); await A.json('POST', `${P}/drafts/${d.id}/approve`, {}); const same = (await A.json('PATCH', `${P}/drafts/${d.id}`, { caption: 'Changed after approval', title: 'only the title' })).body; expect(same.approvedAt).toBeTruthy();    // a title change is not a change of words
  });
  it('a photograph already on Instagram needs an explicit acknowledgement; the override is recorded', async (ctx) => {
    need(ctx);
    const s = await seedOne(h!.svc, ua, { title: 'Posted before' });
    const [acct] = await h!.svc<{ id: string }[]>`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, status) VALUES (${ua}, 'instagram', ${randomUUID()}, 'x', 'BUSINESS', 'DISCONNECTED') RETURNING id`;
    const [post] = await h!.svc<{ id: string }[]>`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, media_type, posted_at, caption, origin, raw) VALUES (${ua}, ${acct!.id}, ${randomUUID()}, 'IMAGE', now() - interval '20 days', 'old', 'SYNCED', '{}'::jsonb) RETURNING id`;
    const [m] = await h!.svc<{ id: string }[]>`INSERT INTO social_post_media (user_id, social_post_id, position, platform_media_id) VALUES (${ua}, ${post!.id}, 0, ${randomUUID()}) RETURNING id`;
    await h!.svc`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, photo_version_id, state, phash_distance, score) VALUES (${ua}, ${m!.id}, ${s.photoId}, ${s.versionId}, 'EXACT_MATCH', 0, 1)`;
    const d = await draft(A, s.photoId); await ready(A, d.id);
    const refused = await A.json('POST', `${P}/drafts/${d.id}/approve`, {}); expect(refused.status).toBe(409); expect(refused.body.error).toBe('history'); expect(refused.body.history).toMatchObject({ kind: 'same', count: 1 });
    const ok = (await A.json('POST', `${P}/drafts/${d.id}/approve`, { acknowledgeHistory: true })).body; expect(ok.approvedAt).toBeTruthy(); expect(ok.historyOverrideAt).toBeTruthy(); expect(ok.historyCheck.kind).toBe('same');
  });
  it('the database itself refuses scheduling an unapproved draft, even around the API', async (ctx) => {
    need(ctx);
    const d = await draft(A, await photo());
    await expect(h!.svc`INSERT INTO scheduled_publications (user_id, draft_id, scheduled_at, timezone, state) VALUES (${ua}, ${d.id}, now() + interval '2 hours', 'UTC', 'SCHEDULED')`).rejects.toThrow(/not been approved/);
  });
});

describe('schedule', () => {
  it('schedules an approved draft, shows it, and refuses the past, bad zones and double scheduling', async (ctx) => {
    need(ctx);
    const p = await photo(); const d = await draft(A, p); await ready(A, d.id); await A.json('POST', `${P}/drafts/${d.id}/approve`, {});
    expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: new Date(Date.now() - 3600_000).toISOString(), timezone: 'UTC' })).status).toBe(400);
    expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: new Date(Date.now() + 10_000).toISOString(), timezone: 'UTC' })).status).toBe(400);
    expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(), timezone: 'Mars/Olympus' })).status).toBe(400); expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: 'tomorrow', timezone: 'UTC' })).status).toBe(400);
    const s = await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(180), timezone: 'Europe/London' }); expect(s.status).toBe(200); expect(s.body).toMatchObject({ state: 'SCHEDULED', schedule: { state: 'SCHEDULED', timezone: 'Europe/London', attemptCount: 0 } });
    expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: future(), timezone: 'UTC' })).status).toBe(409);
    expect((await A.json('PATCH', `${P}/drafts/${d.id}`, { caption: 'no edits while scheduled' })).status).toBe(409); expect((await A.json('POST', `${P}/drafts/${d.id}/unready`)).status).toBe(409);
  });
  it('drag-reschedule moves the time; cancel returns the draft to ready (approval kept) and it can be scheduled again', async (ctx) => {
    need(ctx);
    const s = await full(A, await photo()); const sid = s.schedule.id;
    const moved = await A.json('PATCH', `${P}/schedule/${sid}`, { scheduledAt: future(300) }); expect(moved.status).toBe(200); expect(new Date(moved.body.schedule.scheduledAt).getTime()).toBeGreaterThan(Date.now() + 290 * 60_000);
    expect((await A.json('PATCH', `${P}/schedule/${sid}`, { scheduledAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    const c = await A.json('POST', `${P}/schedule/${sid}/cancel`); expect(c.body).toMatchObject({ state: 'READY', schedule: { state: 'CANCELLED' } }); expect(c.body.approvedAt).toBeTruthy();
    expect((await A.json('POST', `${P}/schedule/${sid}/cancel`)).status).toBe(200);
    const again = await A.json('POST', `${P}/drafts/${s.id}/schedule`, { scheduledAt: future(200), timezone: 'UTC' }); expect(again.body).toMatchObject({ state: 'SCHEDULED', schedule: { id: sid, state: 'SCHEDULED', timezone: 'UTC' } });
  });
  it('another account cannot move or cancel my schedule', async (ctx) => {
    need(ctx);
    const s = await full(A, await photo());
    expect((await B.json('PATCH', `${P}/schedule/${s.schedule.id}`, { scheduledAt: future() })).status).toBe(404); expect((await B.json('POST', `${P}/schedule/${s.schedule.id}/cancel`)).status).toBe(404);
  });
  it('a failed publication can be retried by the person: back to scheduled with its attempts reset', async (ctx) => {
    need(ctx);
    const s = await full(A, await photo());
    await h!.svc`UPDATE scheduled_publications SET state = 'FAILED', attempt_count = 3, error_code = 'X', error_message = 'boom' WHERE id = ${s.schedule.id}`;
    const f = (await A.json('GET', `${P}/drafts/${s.id}`)).body; expect(f.schedule).toMatchObject({ state: 'FAILED', errorMessage: 'boom' });
    const r = await A.json('PATCH', `${P}/schedule/${s.schedule.id}`, { scheduledAt: future(240) }); expect(r.body.schedule).toMatchObject({ state: 'SCHEDULED', attemptCount: 0, errorCode: null, errorMessage: null });
  });
  it('published or publishing posts cannot be touched by the API', async (ctx) => {
    need(ctx);
    const s = await full(A, await photo()); await h!.svc`UPDATE scheduled_publications SET state = 'PUBLISHING' WHERE id = ${s.schedule.id}`;
    for (const r of [await A.json('PATCH', `${P}/schedule/${s.schedule.id}`, { scheduledAt: future() }), await A.json('POST', `${P}/schedule/${s.schedule.id}/cancel`), await A.json('POST', `${P}/drafts/${s.id}/cancel`)]) expect(r.status).toBe(409);
  });
  it('Instagram’s 25-posts-per-24-hours limit is enforced for the window around a slot', async (ctx) => {
    need(ctx);
    const base = Date.now() + 40 * 86_400_000;
    for (let i = 0; i < 25; i++) { const d = await draft(A, await photo(), `cap ${i}`); await ready(A, d.id); await A.json('POST', `${P}/drafts/${d.id}/approve`, {}); const r = await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: new Date(base + i * 60_000).toISOString(), timezone: 'UTC' }); expect(r.status, `slot ${i}`).toBe(200); }
    const d = await draft(A, await photo(), 'one too many'); await ready(A, d.id); await A.json('POST', `${P}/drafts/${d.id}/approve`, {});
    const over = await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: new Date(base + 12 * 3600_000).toISOString(), timezone: 'UTC' }); expect(over.status).toBe(409); expect(over.body.error).toBe('limit');
    expect((await A.json('POST', `${P}/drafts/${d.id}/schedule`, { scheduledAt: new Date(base + 3 * 86_400_000).toISOString(), timezone: 'UTC' })).status).toBe(200);
  });
});

describe('cancel, reopen, calendar', () => {
  it('cancelling a scheduled draft cancels its schedule; a cancelled draft can be reopened as a draft needing fresh approval', async (ctx) => {
    need(ctx);
    const s = await full(A, await photo()); const c = await A.json('POST', `${P}/drafts/${s.id}/cancel`); expect(c.body).toMatchObject({ state: 'CANCELLED', schedule: { state: 'CANCELLED' } });
    expect((await A.json('PATCH', `${P}/drafts/${s.id}`, { caption: 'x' })).status).toBe(409);
    expect((await A.json('POST', `${P}/drafts/${s.id}/reopen`)).body).toMatchObject({ state: 'DRAFT', approvedAt: null }); expect((await A.json('POST', `${P}/drafts/${s.id}/reopen`)).status).toBe(409);
  });
  it('the calendar lists what is scheduled in a window, never cancelled posts, and only mine', async (ctx) => {
    need(ctx);
    const at = new Date(Date.now() + 60 * 86_400_000); const day = at.toISOString().slice(0, 10);
    const d1 = await draft(A, await photo(ua, { title: 'Cal one' })); await ready(A, d1.id); await A.json('POST', `${P}/drafts/${d1.id}/approve`, {}); await A.json('POST', `${P}/drafts/${d1.id}/schedule`, { scheduledAt: at.toISOString(), timezone: 'Europe/London' });
    const d2 = await draft(A, await photo()); await ready(A, d2.id); await A.json('POST', `${P}/drafts/${d2.id}/approve`, {}); const s2 = (await A.json('POST', `${P}/drafts/${d2.id}/schedule`, { scheduledAt: new Date(at.getTime() + 3600_000).toISOString(), timezone: 'UTC' })).body; await A.json('POST', `${P}/schedule/${s2.schedule.id}/cancel`);
    const r = (await A.json('GET', `${P}/calendar?from=${day}&to=${day}`)).body; expect(r.items).toHaveLength(1); expect(r.items[0]).toMatchObject({ title: 'Cal one', state: 'SCHEDULED', timezone: 'Europe/London', draftId: d1.id });
    expect((await B.json('GET', `${P}/calendar?from=${day}&to=${day}`)).body.items).toEqual([]);
    for (const q of ['from=2026-01-01&to=2025-01-01', 'from=2026-01-01&to=2026-06-01', 'from=x&to=y', 'from=2026-01-01']) expect((await A.json('GET', `${P}/calendar?${q}`)).status, q).toBe(400);
  });
});

describe('suggestions', () => {
  it('captions use only facts a person confirmed (an AI-suggested species is not used); hashtags carry reasons', async (ctx) => {
    need(ctx);
    const s = await seedOne(h!.svc, ua, { title: 'Suggest me', location: 'Kenya', captureAt: new Date('2024-06-14T17:00:00Z') });
    const [lion] = await h!.svc<{ id: string }[]>`INSERT INTO species (user_id, common_name, scientific_name) VALUES (${ua}, 'Lion', 'Panthera leo') ON CONFLICT (user_id, lower(common_name)) DO UPDATE SET common_name = excluded.common_name RETURNING id`;
    const [eleph] = await h!.svc<{ id: string }[]>`INSERT INTO species (user_id, common_name) VALUES (${ua}, 'Elephant') ON CONFLICT (user_id, lower(common_name)) DO UPDATE SET common_name = excluded.common_name RETURNING id`;
    await h!.svc`INSERT INTO photo_species (user_id, photo_id, species_id, confidence, source, status) VALUES (${ua}, ${s.photoId}, ${lion!.id}, 1, 'USER_DEFINED', 'CONFIRMED'), (${ua}, ${s.photoId}, ${eleph!.id}, 0.8, 'AI_INFERRED', 'SUGGESTED')`;
    const r = (await A.json('POST', `${P}/captions/suggest`, { photoId: s.photoId })).body; expect(r.model).toBe('local-template-v1');
    const short = r.suggestions.find((x: { style: string }) => x.style === 'SHORT'); expect(short.body).toBe('Lion in Kenya, June 2024.'); expect(JSON.stringify(r)).not.toMatch(/elephant/i);
    const t = (await A.json('GET', `${P}/hashtags/suggest?photoId=${s.photoId}`)).body.suggestions; expect(t.find((x: { tag: string }) => x.tag === 'lion').reason).toBe('the species'); expect(t.map((x: { tag: string }) => x.tag)).not.toContain('elephant');
    expect((await B.json('POST', `${P}/captions/suggest`, { photoId: s.photoId })).status).toBe(404); expect((await A.json('GET', `${P}/hashtags/suggest?photoId=${randomUUID()}`)).status).toBe(404);
  });
});

describe('safety and access', () => {
  it('no API route can publish: nothing moves a draft or schedule to PUBLISHING/PUBLISHED, and the API role is refused by the database', async (ctx) => {
    need(ctx);
    const s = await full(A, await photo());
    await expect(h!.app.begin(async (tx) => { await tx`SELECT set_config('app.user_id', ${ua}, true)`; await tx`UPDATE scheduled_publications SET state = 'PUBLISHED' WHERE id = ${s.schedule.id}`; })).rejects.toThrow(/may only set state/);
    const before = (await h!.svc`SELECT count(*)::int AS n FROM publication_attempts`)[0]!.n; await A.json('POST', `${P}/drafts/${s.id}/cancel`); expect((await h!.svc`SELECT count(*)::int AS n FROM publication_attempts`)[0]!.n).toBe(before);
  });
  it('every route needs a session and (for writes) the CSRF token', async (ctx) => {
    need(ctx);
    const anon = new ApiClient(app); const id = randomUUID();
    for (const [m, u] of [['GET', `${P}/drafts`], ['POST', `${P}/drafts`], ['GET', `${P}/drafts/${id}`], ['PATCH', `${P}/drafts/${id}`], ['POST', `${P}/drafts/${id}/ready`], ['POST', `${P}/drafts/${id}/approve`], ['POST', `${P}/drafts/${id}/schedule`], ['PATCH', `${P}/schedule/${id}`], ['POST', `${P}/schedule/${id}/cancel`], ['GET', `${P}/calendar?from=2026-01-01&to=2026-01-31`], ['POST', `${P}/captions/suggest`], ['GET', `${P}/hashtags/suggest?photoId=${id}`]] as const)
      expect((await anon.json(m, u, m === 'GET' ? undefined : {})).status, `${m} ${u}`).toBe(401);
    expect((await A.req('POST', `${P}/drafts`, { photoId: randomUUID() }, { csrf: false })).statusCode).toBe(403); expect((await A.json('GET', `${P}/drafts/nope`)).status).toBe(400);
  });
});
