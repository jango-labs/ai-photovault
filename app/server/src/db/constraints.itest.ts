import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedPhoto, seedUser, sha, tryHandles, wipe, withUser, type Handles } from './testdb.js';

let h: Handles | null;
beforeAll(async () => { h = await tryHandles(); });
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); return h!; };

let U = '';
let P: Awaited<ReturnType<typeof seedPhoto>>;
beforeEach(async () => {
  if (!h) return;
  await wipe(h.svc);
  U = await seedUser(h.svc); P = await seedPhoto(h.svc, U, { title: 't' });
});
const check = { code: "23514" }; const unique = { code: "23505" };

describe('photo data integrity', () => {
  it('rating is 0..5', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`UPDATE photos SET rating = 6 WHERE id = ${P.photoId}`).rejects.toMatchObject(check);
    await expect(svc`UPDATE photos SET rating = -1 WHERE id = ${P.photoId}`).rejects.toMatchObject(check);
    await svc`UPDATE photos SET rating = 5 WHERE id = ${P.photoId}`;
  });
  it('metadata values must carry provenance', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`UPDATE photos SET title = 'x', title_source = NULL WHERE id = ${P.photoId}`).rejects.toMatchObject(check);
    await expect(svc`UPDATE photos SET trip_location = 'Kenya' WHERE id = ${P.photoId}`).rejects.toMatchObject(check);
    await expect(svc`UPDATE photos SET trip_location = 'Kenya', trip_location_source = 'GUESS' WHERE id = ${P.photoId}`).rejects.toMatchObject(check);
    await svc`UPDATE photos SET trip_location = 'Kenya', trip_location_source = 'FOLDER_DERIVED' WHERE id = ${P.photoId}`;
    await expect(svc`UPDATE photo_versions SET gps_lat = 1, gps_lon = 2 WHERE id = ${P.versionId}`).rejects.toMatchObject(check);      // GPS needs a source
    await expect(svc`UPDATE photo_versions SET gps_lat = 1, gps_source = 'EXIF' WHERE id = ${P.versionId}`).rejects.toMatchObject(check); // lat without lon
    await expect(svc`UPDATE photo_versions SET gps_lat = 91, gps_lon = 2, gps_source = 'EXIF' WHERE id = ${P.versionId}`).rejects.toMatchObject(check);
  });
  it('allows exactly one ACTIVE version per photo; versions are unique by content', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`INSERT INTO photo_versions (user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, state)
      VALUES (${U}, ${P.photoId}, 2, ${P.rootId}, 'b.jpg', ${sha(2)}, 'ACTIVE')`).rejects.toMatchObject(unique);
    const [v] = await svc`INSERT INTO photo_versions (user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, state)
      VALUES (${U}, ${P.photoId}, 2, ${P.rootId}, 'b.jpg', ${sha(2)}, 'PENDING_REVIEW') RETURNING id`;
    expect(v!.id).toBeTruthy();
    await expect(svc`INSERT INTO photo_versions (user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256)
      VALUES (${U}, ${P.photoId}, 3, ${P.rootId}, 'c.jpg', ${sha(2)})`).rejects.toMatchObject(unique);
  });
  it('rejects bad hashes, mime types and unsafe relative paths', async (ctx) => {
    const { svc } = need(ctx);
    const ins = (relpath: string, hash: Buffer, mime = 'image/jpeg', n = 5) => svc`INSERT INTO photo_versions (user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, mime)
      VALUES (${U}, ${P.photoId}, ${n}, ${P.rootId}, ${relpath}, ${hash}, ${mime})`;
    await expect(ins('a.jpg', Buffer.alloc(16))).rejects.toMatchObject(check);
    await expect(ins('a.jpg', sha(4), 'image/x-raw')).rejects.toMatchObject(check);
    await expect(ins('/abs/a.jpg', sha(4))).rejects.toMatchObject(check);
    await expect(ins('../../etc/passwd', sha(4))).rejects.toMatchObject(check);
  });
  it('library roots are FINAL-only, absolute, never writable', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`INSERT INTO library_roots (user_id, kind, path) VALUES (${U}, 'RAW', '/Volumes/x/RAW')`).rejects.toMatchObject(check);
    await expect(svc`INSERT INTO library_roots (user_id, path, read_only) VALUES (${U}, '/Volumes/x/FINAL', false)`).rejects.toMatchObject(check);
    await expect(svc`INSERT INTO library_roots (user_id, path) VALUES (${U}, 'relative/FINAL')`).rejects.toMatchObject(check);
    await expect(svc`INSERT INTO library_roots (user_id, path) VALUES (${U}, '/')`).rejects.toMatchObject(check);
  });
  it('perceptual hash segments are generated and hamming64 is correct', async (ctx) => {
    const { svc } = need(ctx);
    const [r] = await svc`UPDATE photo_versions SET phash = ${0x0001000200030004n.toString()}::bigint WHERE id = ${P.versionId}
      RETURNING phash_s0, phash_s1, phash_s2, phash_s3`;
    expect([r!.phash_s0, r!.phash_s1, r!.phash_s2, r!.phash_s3]).toEqual([1, 2, 3, 4]);
    expect((await svc`SELECT hamming64(0, 0) AS a, hamming64(0, 1) AS b, hamming64(-1, 0) AS c, hamming64(5, 3) AS d`)[0]).toEqual({ a: 0, b: 1, c: 64, d: 2 });
    await svc`UPDATE photo_versions SET phash = -1 WHERE id = ${P.versionId}`;   // sign bit set: all segments 65535
    expect((await svc`SELECT phash_s0 AS s FROM photo_versions WHERE id = ${P.versionId}`)[0]!.s).toBe(65535);
  });
  it('collections: smart ones need a query; AI collections stay drafts; names are unique among live collections', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`INSERT INTO collections (user_id, name, kind) VALUES (${U}, 's', 'SMART')`).rejects.toMatchObject(check);
    await svc`INSERT INTO collections (user_id, name, kind, query) VALUES (${U}, 's', 'SMART', '{"minRating":5}')`;
    await expect(svc`INSERT INTO collections (user_id, name, kind, created_by, status) VALUES (${U}, 'ai', 'AI_DRAFT', 'AI', 'ACTIVE')`).rejects.toMatchObject(check);
    await svc`INSERT INTO collections (user_id, name, kind, created_by, status) VALUES (${U}, 'ai', 'AI_DRAFT', 'AI', 'DRAFT')`;
    await expect(svc`INSERT INTO collections (user_id, name) VALUES (${U}, 'S')`).rejects.toMatchObject(unique);
  });
  it('collection membership cascades and is unique per photo', async (ctx) => {
    const { svc } = need(ctx);
    const [c] = await svc`INSERT INTO collections (user_id, name) VALUES (${U}, 'c') RETURNING id`;
    await svc`INSERT INTO collection_photos (user_id, collection_id, photo_id) VALUES (${U}, ${c!.id}, ${P.photoId})`;
    await expect(svc`INSERT INTO collection_photos (user_id, collection_id, photo_id) VALUES (${U}, ${c!.id}, ${P.photoId})`).rejects.toMatchObject(unique);
    await svc`DELETE FROM photos WHERE id = ${P.photoId}`;
    expect(await svc`SELECT 1 FROM collection_photos WHERE collection_id = ${c!.id}`).toHaveLength(0);   // no stale membership (the Base44 flaw)
  });
});

describe('AI data rules', () => {
  it('AI analyses are immutable; user-defined species are always confirmed; rejections are remembered', async (ctx) => {
    const { svc } = need(ctx);
    const [a] = await svc`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, overall_score) VALUES (${U}, ${P.versionId}, 'mock', 'mock', 'v1', 'mock', 0.5) RETURNING id`;
    await expect(svc`UPDATE ai_analyses SET description = 'x' WHERE id = ${a!.id}`).rejects.toMatchObject({ code: '55000' });
    await expect(svc`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, overall_score) VALUES (${U}, ${P.versionId}, 'm', 'm', 'v', 'mock', 1.5)`).rejects.toMatchObject(check);
    const [s] = await svc`INSERT INTO species (user_id, common_name, scientific_name) VALUES (${U}, 'African elephant', 'Loxodonta africana') RETURNING id`;
    await expect(svc`INSERT INTO species (user_id, common_name) VALUES (${U}, 'african ELEPHANT')`).rejects.toMatchObject(unique);
    await expect(svc`INSERT INTO photo_species (user_id, photo_id, species_id, source, status) VALUES (${U}, ${P.photoId}, ${s!.id}, 'USER_DEFINED', 'SUGGESTED')`).rejects.toMatchObject(check);
    await svc`INSERT INTO photo_species (user_id, photo_id, species_id, source, status, confidence, analysis_id) VALUES (${U}, ${P.photoId}, ${s!.id}, 'AI_INFERRED', 'REJECTED', 0.4, ${a!.id})`;
    await expect(svc`INSERT INTO photo_species (user_id, photo_id, species_id, source, status) VALUES (${U}, ${P.photoId}, ${s!.id}, 'AI_INFERRED', 'SUGGESTED')`).rejects.toMatchObject(unique);
  });
  it('live AI cannot be enabled without an approval stamp; the ledger is append-only', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`INSERT INTO ai_budget (user_id, live_enabled) VALUES (${U}, true)`).rejects.toMatchObject(check);
    const [b] = await svc`INSERT INTO ai_budget (user_id) VALUES (${U}) RETURNING live_enabled, lifetime_photo_cap`;
    expect(b).toEqual({ live_enabled: false, lifetime_photo_cap: 200 });
    const [l] = await svc`INSERT INTO ai_usage_ledger (user_id, provider, model, purpose, est_cost_usd) VALUES (${U}, 'x', 'y', 'z', 0.01) RETURNING id`;
    await expect(svc`UPDATE ai_usage_ledger SET est_cost_usd = 0 WHERE id = ${l!.id}`).rejects.toMatchObject({ code: '55000' });
    await expect(svc`DELETE FROM ai_usage_ledger WHERE id = ${l!.id}`).rejects.toMatchObject({ code: '55000' });
  });
  it('embeddings are provider-agnostic but dimension-checked; sync events are append-only', async (ctx) => {
    const { svc } = need(ctx);
    const v = (n: number) => `[${Array.from({ length: n }, (_, i) => (i % 7) / 7).join(',')}]`;
    await expect(svc`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${U}, ${P.versionId}, 'm', 'image', 8, ${v(4)}::halfvec)`).rejects.toMatchObject(check);
    await svc`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding) VALUES (${U}, ${P.versionId}, 'other-model', 'image', 4, ${v(4)}::halfvec)`;
    const [e] = await svc`INSERT INTO sync_events (user_id, type, relpath) VALUES (${U}, 'REGISTERED', 'a.jpg') RETURNING id`;
    await expect(svc`UPDATE sync_events SET type = 'X' WHERE id = ${e!.id}`).rejects.toMatchObject({ code: '55000' });
    await expect(svc`DELETE FROM sync_events WHERE id = ${e!.id}`).rejects.toMatchObject({ code: '55000' });
  });
});

describe('Instagram history and matching', () => {
  async function seedPost() {
    const svc = h!.svc;
    const [acct] = await svc`INSERT INTO social_accounts (user_id, platform, external_id) VALUES (${U}, 'instagram', 'ig1') RETURNING id`;
    const [post] = await svc`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, posted_at, caption, hashtags) VALUES (${U}, ${acct!.id}, 'p1', now() - interval '400 days', 'Elephant #kenya', ARRAY['kenya']) RETURNING id`;
    const [media] = await svc`INSERT INTO social_post_media (user_id, social_post_id, position, phash) VALUES (${U}, ${post!.id}, 0, 12345) RETURNING id`;
    return { acct: acct!.id as string, post: post!.id as string, media: media!.id as string };
  }
  it('one verdict per pair; user decisions need a user; status view follows confirmed matches', async (ctx) => {
    const { svc } = need(ctx);
    const s = await seedPost();
    expect((await svc`SELECT status, posted_count FROM photo_instagram_status WHERE photo_id = ${P.photoId}`)[0]).toEqual({ status: 'NEVER_POSTED', posted_count: 0 });
    await expect(svc`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, state) VALUES (${U}, ${s.media}, ${P.photoId}, 'USER_CONFIRMED')`).rejects.toMatchObject(check);
    await svc`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, state, score) VALUES (${U}, ${s.media}, ${P.photoId}, 'POSSIBLE_MATCH', 0.92)`;
    expect((await svc`SELECT status FROM photo_instagram_status WHERE photo_id = ${P.photoId}`)[0]!.status).toBe('NEVER_POSTED');   // possible != posted
    await expect(svc`INSERT INTO photo_social_matches (user_id, social_post_media_id, photo_id, state) VALUES (${U}, ${s.media}, ${P.photoId}, 'EXACT_MATCH')`).rejects.toMatchObject(unique);
    await svc`UPDATE photo_social_matches SET state = 'USER_CONFIRMED', decided_by = 'USER', decided_at = now()`;
    const st = (await svc`SELECT status, posted_count, last_posted_at FROM photo_instagram_status WHERE photo_id = ${P.photoId}`)[0]!;
    expect(st.status).toBe('POSTED'); expect(st.posted_count).toBe(1); expect(st.last_posted_at).toBeTruthy();
    await svc`UPDATE photo_social_matches SET state = 'USER_REJECTED'`;
    expect((await svc`SELECT status FROM photo_instagram_status WHERE photo_id = ${P.photoId}`)[0]!.status).toBe('NEVER_POSTED');
  });
  it('a post can only be stored once per account; a connected account needs a token', async (ctx) => {
    const { svc } = need(ctx);
    const s = await seedPost();
    await expect(svc`INSERT INTO social_posts (user_id, social_account_id, platform_post_id, posted_at) VALUES (${U}, ${s.acct}, 'p1', now())`).rejects.toMatchObject(unique);
    await expect(svc`UPDATE social_accounts SET status = 'CONNECTED' WHERE id = ${s.acct}`).rejects.toMatchObject(check);
  });
});

describe('publishing safety rules', () => {
  async function draft(o: { createdBy?: 'USER' | 'AI'; approved?: boolean; state?: string } = {}) {
    const svc = h!.svc;
    const [d] = await svc`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, created_by, state, approved_at, approved_by)
      VALUES (${U}, ${P.photoId}, ${P.versionId}, ${o.createdBy ?? 'USER'}, ${o.state ?? 'DRAFT'}, ${o.approved ? new Date() : null}, ${o.approved ? U : null}) RETURNING id`;
    return d!.id as string;
  }
  const sched = (d: string, extra = '') => h!.svc.unsafe(`INSERT INTO scheduled_publications (user_id, draft_id, scheduled_at, timezone ${extra ? ',' + extra.split('=')[0] : ''}) VALUES ('${U}', '${d}', now() + interval '1 day', 'Europe/London' ${extra ? ',' + extra.split('=')[1] : ''})`);

  it('caption and hashtag limits are enforced', async (ctx) => {
    const { svc } = need(ctx);
    await expect(svc`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, caption_body) VALUES (${U}, ${P.photoId}, ${P.versionId}, ${'x'.repeat(2201)})`).rejects.toMatchObject(check);
    await expect(svc`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, hashtags) VALUES (${U}, ${P.photoId}, ${P.versionId}, ${Array.from({ length: 31 }, (_, i) => 'h' + i)})`).rejects.toMatchObject(check);
  });
  it('nothing can be scheduled or published without a user approval; AI drafts stay drafts', async (ctx) => {
    need(ctx);
    await expect(draft({ state: 'SCHEDULED' })).rejects.toMatchObject(check);
    await expect(draft({ createdBy: 'AI', state: 'READY' })).rejects.toMatchObject(check);
    const unapproved = await draft();
    await expect(sched(unapproved)).rejects.toMatchObject(check);           // trigger: draft not approved
    const aiDraft = await draft({ createdBy: 'AI' });
    await expect(sched(aiDraft)).rejects.toMatchObject(check);
    const ok = await draft({ approved: true, state: 'READY' });
    await sched(ok);
    await expect(sched(ok)).rejects.toMatchObject(unique);                    // one schedule per draft
  });
  it('PUBLISHED requires a verified platform post id; attempts imply a container', async (ctx) => {
    const { svc } = need(ctx);
    const d = await draft({ approved: true, state: 'READY' }); await sched(d);
    await expect(svc`UPDATE scheduled_publications SET state = 'PUBLISHED' WHERE draft_id = ${d}`).rejects.toMatchObject(check);
    await expect(svc`UPDATE scheduled_publications SET state = 'PUBLISHED', platform_post_id = 'p' WHERE draft_id = ${d}`).rejects.toMatchObject(check);
    await expect(svc`UPDATE scheduled_publications SET publish_requested_at = now() WHERE draft_id = ${d}`).rejects.toMatchObject(check);
    await svc`UPDATE scheduled_publications SET container_id = 'c1', publish_requested_at = now(), platform_post_id = 'p1', verified_at = now(), published_at = now(), state = 'PUBLISHED' WHERE draft_id = ${d}`;
    const d2 = await draft({ approved: true, state: 'READY' }); await sched(d2);
    await expect(svc`UPDATE scheduled_publications SET platform_post_id = 'p1' WHERE draft_id = ${d2}`).rejects.toMatchObject(unique);   // same post cannot be claimed twice
  });
  it('API role may schedule and cancel, but only the scheduler moves a publication through its states', async (ctx) => {
    const { app, svc } = need(ctx);
    const d = await draft({ approved: true, state: 'READY' });
    const mk = (state: string) => withUser(app, U, (tx) => tx`INSERT INTO scheduled_publications (user_id, draft_id, scheduled_at, timezone, state) VALUES (${U}, ${d}, now() + interval '1 day', 'UTC', ${state}) RETURNING id`);
    await expect(mk('PUBLISHED')).rejects.toMatchObject({ code: '42501' });
    await expect(mk('PUBLISHING')).rejects.toMatchObject({ code: '42501' });
    const [sp] = await mk('SCHEDULED');
    await expect(withUser(app, U, (tx) => tx`UPDATE scheduled_publications SET state = 'PUBLISHING' WHERE id = ${sp!.id}`)).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(app, U, (tx) => tx`UPDATE scheduled_publications SET container_id = 'forged' WHERE id = ${sp!.id}`)).rejects.toMatchObject({ code: '42501' });
    await withUser(app, U, (tx) => tx`UPDATE scheduled_publications SET scheduled_at = now() + interval '2 days' WHERE id = ${sp!.id}`);   // reschedule
    await withUser(app, U, (tx) => tx`UPDATE scheduled_publications SET state = 'CANCELLED' WHERE id = ${sp!.id}`);
    // user retry after a failure resets attempts
    await svc`UPDATE scheduled_publications SET state = 'FAILED', attempt_count = 3, error_code = 'TRANSIENT' WHERE id = ${sp!.id}`;
    await withUser(app, U, (tx) => tx`UPDATE scheduled_publications SET state = 'SCHEDULED' WHERE id = ${sp!.id}`);
    expect((await svc`SELECT state, attempt_count, error_code FROM scheduled_publications WHERE id = ${sp!.id}`)[0]).toEqual({ state: 'SCHEDULED', attempt_count: 0, error_code: null });
    await svc`UPDATE scheduled_publications SET state = 'PUBLISHING' WHERE id = ${sp!.id}`;
    await expect(withUser(app, U, (tx) => tx`UPDATE scheduled_publications SET state = 'CANCELLED' WHERE id = ${sp!.id}`)).rejects.toMatchObject({ code: '42501' });   // mid-publish
  });
  it('publication attempts are append-only once finished; delivery tokens live at most an hour', async (ctx) => {
    const { svc } = need(ctx);
    const d = await draft({ approved: true, state: 'READY' }); await sched(d);
    const [sp] = await svc`SELECT id FROM scheduled_publications WHERE draft_id = ${d}`;
    const [a] = await svc`INSERT INTO publication_attempts (user_id, scheduled_publication_id, phase) VALUES (${U}, ${sp!.id}, 'CREATE_CONTAINER') RETURNING id`;
    await svc`UPDATE publication_attempts SET finished_at = now(), outcome = 'OK' WHERE id = ${a!.id}`;
    await expect(svc`UPDATE publication_attempts SET outcome = 'FAILED' WHERE id = ${a!.id}`).rejects.toMatchObject({ code: '55000' });
    await expect(svc`DELETE FROM publication_attempts WHERE id = ${a!.id}`).rejects.toMatchObject({ code: '55000' });
    await expect(svc`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, expires_at) VALUES (${U}, ${sp!.id}, ${sha(1)}, 'a.jpg', now() + interval '2 hours')`).rejects.toMatchObject(check);
    await expect(svc`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, expires_at) VALUES (${U}, ${sp!.id}, ${sha(1)}, '../a.jpg', now() + interval '10 minutes')`).rejects.toMatchObject(check);
    await svc`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, expires_at) VALUES (${U}, ${sp!.id}, ${sha(1)}, 'a.jpg', now() + interval '20 minutes')`;
  });
  it('the photo status view reports draft and scheduled state', async (ctx) => {
    const { svc } = need(ctx);
    await draft();
    expect((await svc`SELECT status FROM photo_instagram_status WHERE photo_id = ${P.photoId}`)[0]!.status).toBe('DRAFT');
    const d = await draft({ approved: true, state: 'READY' }); await sched(d);
    expect((await svc`SELECT status FROM photo_instagram_status WHERE photo_id = ${P.photoId}`)[0]!.status).toBe('SCHEDULED');
  });
  it('deleting a user erases everything they own, including append-only history', async (ctx) => {
    const { svc } = need(ctx);
    const d = await draft({ approved: true, state: 'READY' }); await sched(d);
    const [sp] = await svc`SELECT id FROM scheduled_publications WHERE draft_id = ${d}`;
    await svc`INSERT INTO publication_attempts (user_id, scheduled_publication_id, phase, finished_at, outcome) VALUES (${U}, ${sp!.id}, 'PUBLISH', now(), 'OK')`;
    await svc`INSERT INTO sync_events (user_id, type) VALUES (${U}, 'X')`;
    await svc`INSERT INTO ai_usage_ledger (user_id, provider, model, purpose, est_cost_usd) VALUES (${U}, 'a', 'b', 'c', 0)`;
    await svc`DELETE FROM users WHERE id = ${U}`;
    for (const t of ['photos', 'photo_versions', 'publishing_drafts', 'scheduled_publications', 'publication_attempts', 'sync_events', 'ai_usage_ledger'])
      expect((await svc.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n, t).toBe(0);
  });
});
void randomUUID;
