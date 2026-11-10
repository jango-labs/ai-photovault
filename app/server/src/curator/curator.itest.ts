import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne, type SeedOpts } from '../db/test-client.js';
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

const vec = (...head: number[]) => { const a = Array.from({ length: 256 }, (_, k) => (k < head.length ? head[k]! : 0)); const n = Math.hypot(...a); return `[${a.map((x) => (x / n).toFixed(6)).join(',')}]`; };
interface P extends SeedOpts { species?: string; overall?: number; posted?: boolean; portfolio?: boolean; favorite?: boolean; emb?: string }
async function photo(user: string, o: P = {}) {
  const s = await seedOne(h!.svc, user, { captureAt: new Date('2024-06-01T10:00:00Z'), year: 2024, ...o });
  if (o.portfolio || o.favorite) await h!.svc`UPDATE photos SET portfolio_candidate = ${!!o.portfolio}, favorite = ${!!o.favorite} WHERE id = ${s.photoId}`;
  if (o.species) {
    const [sp] = await h!.svc<{ id: string }[]>`INSERT INTO species (user_id, common_name) VALUES (${user}, ${o.species}) ON CONFLICT (user_id, lower(common_name)) DO UPDATE SET common_name = excluded.common_name RETURNING id`;
    await h!.svc`INSERT INTO photo_species (user_id, photo_id, species_id, confidence, source, status) VALUES (${user}, ${s.photoId}, ${sp!.id}, 0.9, 'USER_DEFINED', 'CONFIRMED')`;
  }
  if (o.overall !== undefined) await h!.svc`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, primary_subject, description, suggested_title, scenes, tags, dominant_color_names, scores, overall_score, confidence)
      VALUES (${user}, ${s.versionId}, 'local', 'local-image-v1', 'local-1', 'local', NULL, NULL, NULL, '{}', '{}', '{}', ${h!.svc.json({ sharpness: o.overall, exposure: 0.7 } as never)}, ${o.overall}, '{}'::jsonb)`;
  if (o.emb) await h!.svc`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${user}, ${s.versionId}, 'local-visual-v1', 'image', 256, ${o.emb}::halfvec)`;
  if (o.posted) {
    const [acct] = await h!.svc<{ id: string }[]>`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, status) VALUES (${user}, 'instagram', ${randomUUID()}, 'x', 'BUSINESS', 'DISCONNECTED') RETURNING id`;
    const [post] = await h!.svc<{ id: string }[]>`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, media_type, posted_at, caption, origin, raw) VALUES (${user}, ${acct!.id}, ${randomUUID()}, 'IMAGE', now() - interval '10 days', 'c', 'SYNCED', '{}'::jsonb) RETURNING id`;
    const [media] = await h!.svc<{ id: string }[]>`INSERT INTO social_post_media (user_id, social_post_id, position, platform_media_id) VALUES (${user}, ${post!.id}, 0, ${randomUUID()}) RETURNING id`;
    await h!.svc`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, photo_version_id, state, phash_distance, score) VALUES (${user}, ${media!.id}, ${s.photoId}, ${s.versionId}, 'EXACT_MATCH', 0, 1)`;
  }
  return s.photoId;
}
const run = (c: ApiClient, body: Record<string, unknown>) => c.json('POST', '/api/curator/run', body);
const picks = (b: { picks: Array<{ id: string }> }) => b.picks.map((p) => p.id);
const counts = async () => Object.fromEntries(await Promise.all(['publishing_drafts', 'scheduled_publications', 'publication_attempts', 'caption_versions', 'jobs'].map(async (t) => [t, (await h!.svc.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n])));

describe('curator runs', () => {
  let burstBest: string, burstTwin: string, lionFour: string, posted: string, theirs: string;
  beforeAll(async () => {
    if (!h) return;
    burstBest = await photo(ua, { title: 'Lion burst best', species: 'Lion', location: 'Kenya', rating: 5, overall: 0.9, emb: vec(1, 0.01) });
    burstTwin = await photo(ua, { title: 'Lion burst twin', species: 'Lion', location: 'Kenya', rating: 4, overall: 0.8, emb: vec(1, 0.02) });
    lionFour = await photo(ua, { title: 'Lion walking', species: 'Lion', location: 'Kenya', rating: 4, overall: 0.7, emb: vec(0, 0, 1) });
    await photo(ua, { title: 'Lion resting', species: 'Lion', location: 'Kenya', rating: 3, emb: vec(0, 1) });
    await photo(ua, { title: 'Lion unrated', species: 'Lion', location: 'Kenya', emb: vec(0, 0, 0, 1) });
    posted = await photo(ua, { title: 'Lion already posted', species: 'Lion', location: 'Kenya', rating: 5, overall: 0.95, posted: true, emb: vec(0, 0, 0, 0, 1) });
    await photo(ua, { title: 'Elephant', species: 'African elephant', location: 'Kenya', rating: 5, overall: 0.9, emb: vec(0, 0, 0, 0, 0, 1) });
    theirs = await photo(ub, { title: 'Their lion', species: 'Lion', location: 'Kenya', rating: 5, overall: 0.99 });
  });

  it('"best lion photos never posted": understood, filtered, ranked, one pick per series, with reasons and cards', async (ctx) => {
    need(ctx);
    const r = await run(A, { request: 'best lion photos never posted', count: 12 });
    expect(r.status).toBe(200);
    expect(r.body.understood.map((u: { label: string }) => u.label).sort()).toEqual(['4–5 stars', 'Lion', 'never posted']);
    expect(picks(r.body)).toEqual([burstBest, lionFour]);                                   // the 3★ and unrated lions fall below "best"; the twin frame hides behind the burst's best
    expect(r.body.picks[0]).toMatchObject({ rank: 1, hidden: [burstTwin] });
    expect(r.body.picks[0].reasons.map((x: { text: string }) => x.text)).toEqual(expect.arrayContaining(['You rated it 5 stars', expect.stringContaining('Measured quality 0.9'), 'Best of 2 similar frames']));
    expect(r.body.skipped.series).toBe(1); expect(r.body.pool.matching).toBe(3);
    expect(Object.keys(r.body.cards).sort()).toEqual([burstBest, burstTwin, lionFour].sort());
    expect(JSON.stringify(r.body)).not.toContain(theirs);                                    // another account's photograph never appears
  });

  it('is saved, listed and re-readable; other accounts cannot read it', async (ctx) => {
    need(ctx);
    const r = (await run(A, { request: 'lion', count: 3 })).body;
    const again = (await A.json('GET', `/api/curator/runs/${r.id}`)).body; expect(picks(again)).toEqual(picks(r)); expect(again.request).toBe('lion');
    expect((await A.json('GET', '/api/curator/runs')).body.items[0]).toMatchObject({ id: r.id, request: 'lion', purpose: 'general', count: 3 });
    expect((await B.json('GET', `/api/curator/runs/${r.id}`)).status).toBe(404); expect((await B.json('GET', '/api/curator/runs')).body.items.map((x: { id: string }) => x.id)).not.toContain(r.id);
  });

  it('Instagram purpose assumes "never posted" (and says so); a photograph posted ten days ago is not offered', async (ctx) => {
    need(ctx);
    const r = (await run(A, { request: 'lion', purpose: 'instagram', count: 10 })).body;
    expect(r.assumed).toEqual(['Instagram selection: only photographs never posted']); expect(picks(r)).not.toContain(posted);
    expect(picks(r)[0]).toBe(burstBest);
  });
  it('naming the purpose in the request ("lion photographs for Instagram") does not make the purpose word a required search word', async (ctx) => {
    need(ctx);
    const plain = (await run(A, { request: 'lion', purpose: 'instagram', count: 10 })).body;
    const typed = (await run(A, { request: 'lion photographs for Instagram', purpose: 'instagram', count: 10 })).body;
    expect(picks(typed).length).toBeGreaterThan(0); expect(picks(typed)).toEqual(picks(plain));
  });
  it('without the Instagram purpose a posted photograph can be chosen, flagged as a rating-based pick', async (ctx) => {
    need(ctx);
    const r = (await run(A, { request: 'lion 5 stars', count: 10 })).body; expect(picks(r)).toContain(posted);
  });
  it('Portfolio purpose leaves out what is already in the portfolio', async (ctx) => {
    need(ctx);
    await h!.svc`UPDATE photos SET portfolio_candidate = true WHERE id = ${lionFour}`;
    const r = (await run(A, { request: 'lion 4+ stars', purpose: 'portfolio', count: 10 })).body;
    expect(r.assumed[0]).toMatch(/not in the portfolio/); expect(picks(r)).not.toContain(lionFour); expect(picks(r)).toContain(burstBest);
    await h!.svc`UPDATE photos SET portfolio_candidate = false WHERE id = ${lionFour}`;
  });

  it('count is respected and validated; unknown fields are refused', async (ctx) => {
    need(ctx);
    expect(picks((await run(A, { request: 'lion', count: 1 })).body)).toHaveLength(1);
    for (const bad of [{ count: 0 }, { count: 61 }, { purpose: 'tiktok' }, { bogus: 1 }, { request: 'x'.repeat(301) }]) expect((await run(A, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await run(A, { request: '' })).status).toBe(200);                                // an empty request means "my best"
  });

  it('an empty library match returns an honest empty selection, not an error', async (ctx) => {
    need(ctx);
    const r = await run(A, { request: 'penguins in Antarctica' }); expect(r.status).toBe(200); expect(r.body.picks).toEqual([]); expect(r.body.pool.matching).toBe(0);
  });
});

describe('feedback, overrides and drafts', () => {
  it('"not this" removes a photograph from future suggestions until cleared; "like" adds a stated boost', async (ctx) => {
    need(ctx);
    const a = await photo(ua, { title: 'Heron A', rating: 5, overall: 0.8, emb: vec(0, 0, 0, 0, 0, 0, 1) }); const b = await photo(ua, { title: 'Heron B', rating: 5, overall: 0.7, emb: vec(0, 0, 0, 0, 0, 0, 0, 1) });
    const first = (await run(A, { request: 'heron', count: 5 })).body; expect(picks(first)).toEqual([a, b]);
    expect((await A.json('POST', '/api/curator/feedback', { photoId: a, verdict: 'DISLIKE', runId: first.id, note: 'soft focus' })).status).toBe(200);
    const second = (await run(A, { request: 'heron', count: 5 })).body; expect(picks(second)).toEqual([b]); expect(second.skipped.disliked).toBeGreaterThanOrEqual(1);
    expect((await A.json('GET', '/api/curator/feedback')).body.disliked.map((c: { id: string }) => c.id)).toEqual([a]);
    await A.json('POST', '/api/curator/feedback', { photoId: a, verdict: 'CLEAR' }); expect(picks((await run(A, { request: 'heron', count: 5 })).body)).toEqual([a, b]);
    await A.json('POST', '/api/curator/feedback', { photoId: b, verdict: 'LIKE' });
    const liked = (await run(A, { request: 'heron', count: 5 })).body; expect(liked.picks.find((p: { id: string }) => p.id === b).reasons.map((r: { factor: string }) => r.factor)).toContain('liked');
    expect((await A.json('GET', '/api/curator/feedback')).body.liked.map((c: { id: string }) => c.id)).toEqual([b]);
  });
  it('feedback is append-only; it needs your own photograph', async (ctx) => {
    need(ctx);
    const id = (await h!.svc<{ id: string }[]>`SELECT id FROM curator_feedback LIMIT 1`)[0]!.id;
    await expect(h!.svc`UPDATE curator_feedback SET verdict = 'LIKE' WHERE id = ${id}`).rejects.toThrow(/append-only/); await expect(h!.svc`DELETE FROM curator_feedback WHERE id = ${id}`).rejects.toThrow(/append-only/);
    const theirs = await photo(ub, { title: 'x' }); expect((await A.json('POST', '/api/curator/feedback', { photoId: theirs, verdict: 'LIKE' })).status).toBe(404);
    expect((await A.json('POST', '/api/curator/feedback', { photoId: randomUUID(), verdict: 'LIKE' })).status).toBe(404); expect((await A.json('POST', '/api/curator/feedback', { photoId: 'x', verdict: 'LIKE' })).status).toBe(400);
  });

  it('saving a selection creates an AI DRAFT (inactive, with rationale, AI-added members in rank order) and never anything else', async (ctx) => {
    need(ctx);
    const [p1, p2, p3] = [await photo(ua, { title: 'Owl 1', rating: 5, overall: 0.9, emb: vec(0, 0, 0, 0, 0, 0, 0, 0, 1) }), await photo(ua, { title: 'Owl 2', rating: 4, overall: 0.8, emb: vec(0, 0, 0, 0, 0, 0, 0, 0, 0, 1) }), await photo(ua, { title: 'Owl 3', rating: 3, overall: 0.7, emb: vec(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1) })];
    const before = await counts();
    const r = (await run(A, { request: 'owl', count: 3 })).body; expect(picks(r)).toEqual([p1, p2, p3]);
    const d = await A.json('POST', `/api/curator/runs/${r.id}/draft`, { photoIds: [p3!, p1!] }); expect(d.status).toBe(201);
    const c = (await A.json('GET', `/api/collections/${d.body.id}`)).body;
    expect(c).toMatchObject({ kind: 'AI_DRAFT', status: 'DRAFT', createdBy: 'AI', count: 2 }); expect(c.rationale).toMatch(/Suggested by the AI Curator for “owl”/);
    expect((await A.json('GET', `/api/collections/${d.body.id}/photos`)).body.items.map((i: { id: string }) => i.id)).toEqual([p3, p1]);
    expect((await h!.svc`SELECT DISTINCT added_by FROM collection_photos WHERE collection_id = ${d.body.id}`).map((x) => x.added_by)).toEqual(['AI']);
    expect((await A.json('GET', '/api/collections')).body.items.map((x: { id: string }) => x.id)).not.toContain(d.body.id);
    expect(await counts()).toEqual(before);                                                  // no draft post, no schedule, no attempt, no caption, no job
    expect((await A.json('POST', `/api/curator/runs/${r.id}/draft`, {})).body.name).toMatch(/^Curator: owl \(2\)$/);          // names never collide
    expect((await A.json('POST', `/api/collections/${d.body.id}/activate`)).status).toBe(200); expect((await A.json('GET', `/api/collections/${d.body.id}`)).body).toMatchObject({ kind: 'MANUAL', status: 'ACTIVE' });
  });
  it('a draft can only contain photographs the curator suggested in that run, and only its owner can make one', async (ctx) => {
    need(ctx);
    const mine = await photo(ua, { title: 'Kiwi', rating: 5, overall: 0.9 }); const other = await photo(ua, { title: 'Not suggested', rating: 1 });
    const r = (await run(A, { request: 'kiwi', count: 3 })).body;
    expect((await A.json('POST', `/api/curator/runs/${r.id}/draft`, { photoIds: [mine!, other!] })).status).toBe(400);
    expect((await A.json('POST', `/api/curator/runs/${r.id}/draft`, { photoIds: [mine!, mine!] })).status).toBe(400);
    expect((await A.json('POST', `/api/curator/runs/${r.id}/draft`, { name: '' })).status).toBe(400);
    expect((await B.json('POST', `/api/curator/runs/${r.id}/draft`, {})).status).toBe(404); expect((await A.json('POST', `/api/curator/runs/${randomUUID()}/draft`, {})).status).toBe(404);
  });
});

describe('themes', () => {
  it('suggests groups of strong never-posted photographs as ready-made requests', async (ctx) => {
    need(ctx);
    for (let i = 0; i < 4; i++) await photo(ua, { title: `Otter ${i}`, species: 'Otter', location: 'Shetland', rating: 5, overall: 0.8 });
    const t = (await A.json('GET', '/api/curator/themes')).body.items;
    expect(t).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Otter in Shetland', request: 'Otter in Shetland 4+ stars never posted', count: 4 })]));
    const r = (await run(A, { request: 'Otter in Shetland 4+ stars never posted', count: 12 })).body; expect(r.pool.matching).toBe(4);       // the suggested request means what it says
  });
});

describe('access control', () => {
  it('needs a session; writes need the CSRF token', async (ctx) => {
    need(ctx);
    const anon = new ApiClient(app); const id = randomUUID();
    for (const [m, u] of [['POST', '/api/curator/run'], ['GET', '/api/curator/runs'], ['GET', `/api/curator/runs/${id}`], ['POST', `/api/curator/runs/${id}/draft`], ['POST', '/api/curator/feedback'], ['GET', '/api/curator/feedback'], ['GET', '/api/curator/themes']] as const)
      expect((await anon.json(m, u, m === 'POST' ? {} : undefined)).status, `${m} ${u}`).toBe(401);
    expect((await A.req('POST', '/api/curator/run', {}, { csrf: false })).statusCode).toBe(403);
  });
});
