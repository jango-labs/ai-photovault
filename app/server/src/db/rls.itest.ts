import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedPhoto, seedRoot, seedUser, sha, tryHandles, wipe, withUser, type Handles } from './testdb.js';

let h: Handles | null;
beforeAll(async () => { h = await tryHandles(); });
afterAll(async () => { if (h) { await wipe(h.svc); await h.close(); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); return h!; };

let A = '', B = '';
let pa: Awaited<ReturnType<typeof seedPhoto>>, pb: Awaited<ReturnType<typeof seedPhoto>>;
beforeEach(async () => {
  if (!h) return;
  await wipe(h.svc);
  A = await seedUser(h.svc, 'a@example.test'); B = await seedUser(h.svc, 'b@example.test');
  pa = await seedPhoto(h.svc, A, { title: 'A photo' }); pb = await seedPhoto(h.svc, B, { title: 'B photo' });
  for (const [u, p] of [[A, pa], [B, pb]] as const) {
    await h.svc`INSERT INTO collections (user_id, name) VALUES (${u}, ${'c-' + u})`;
    await h.svc`INSERT INTO social_accounts (user_id, platform, external_id, status) VALUES (${u}, 'instagram', ${'ig-' + u}, 'DISCONNECTED')`;
    await h.svc`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id, caption_body) VALUES (${u}, ${p.photoId}, ${p.versionId}, 'hi')`;
    await h.svc`INSERT INTO jobs (user_id, kind) VALUES (${u}, 'derivatives')`;
    await h.svc`INSERT INTO notifications (user_id, severity, kind, title) VALUES (${u}, 'INFO', 'x', 'x')`;
  }
});

describe('row-level security isolation (API role)', () => {
  it('sees only the current user\'s rows in every user-owned table', async (ctx) => {
    const { app, svc } = need(ctx);
    const tables = (await svc`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='user_id'
      WHERE n.nspname='public' AND c.relkind='r'`).map((r) => r.relname as string);
    let checked = 0;
    for (const t of tables) {
      const [{ total }] = (await svc.unsafe(`SELECT count(*)::int AS total FROM ${t}`)) as unknown as [{ total: number }];
      if (total === 0) continue;
      // pv_app may lack SELECT on some tables by design (login_attempts, delivery_tokens); skip those
      const granted = (await svc`SELECT has_table_privilege('pv_app', ${t}, 'SELECT') AS ok`)[0]!.ok;
      if (!granted) continue;
      const own = await withUser(app, A, async (tx) => (await tx.unsafe(`SELECT count(*)::int AS n, count(*) FILTER (WHERE user_id = '${A}')::int AS mine FROM ${t}`))[0]!);
      expect(own!.n, `${t}: rows visible`).toBe(own!.mine);
      expect(own!.n, `${t}: rows visible >0`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('sees nothing without a user context', async (ctx) => {
    const { app } = need(ctx);
    expect((await app`SELECT count(*)::int AS n FROM photos`)[0]!.n).toBe(0);
  });

  it('cannot insert rows for another user (WITH CHECK)', async (ctx) => {
    const { app } = need(ctx);
    await expect(withUser(app, A, (tx) => tx`INSERT INTO collections (user_id, name) VALUES (${B}, 'evil')`)).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot update or delete another user\'s rows (silently 0 rows)', async (ctx) => {
    const { app, svc } = need(ctx);
    const upd = await withUser(app, A, (tx) => tx`UPDATE photos SET rating = 5 WHERE id = ${pb.photoId}`);
    expect(upd.count).toBe(0);
    const del = await withUser(app, A, (tx) => tx`DELETE FROM photos WHERE id = ${pb.photoId}`);
    expect(del.count).toBe(0);
    expect((await svc`SELECT rating FROM photos WHERE id = ${pb.photoId}`)[0]!.rating).toBe(0);
  });

  it('cross-user links are impossible even for the service role (composite foreign keys)', async (ctx) => {
    const { svc } = need(ctx);
    const [c] = await svc`SELECT id FROM collections WHERE user_id = ${A}`;
    await expect(svc`INSERT INTO collection_photos (user_id, collection_id, photo_id) VALUES (${A}, ${c!.id}, ${pb.photoId})`).rejects.toMatchObject({ code: '23503' });
    await expect(svc`INSERT INTO publishing_drafts (user_id, photo_id, photo_version_id) VALUES (${A}, ${pa.photoId}, ${pb.versionId})`).rejects.toMatchObject({ code: '23503' });
    await expect(svc`INSERT INTO photo_versions (user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256) VALUES (${A}, ${pa.photoId}, 2, ${pb.rootId}, 'x.jpg', ${sha(9)})`).rejects.toMatchObject({ code: '23503' });
  });

  it('a photo\'s current version must belong to that photo', async (ctx) => {
    const { svc } = need(ctx);
    const other = await seedPhoto(svc, A);
    await expect(svc`UPDATE photos SET current_version_id = ${other.versionId} WHERE id = ${pa.photoId}`).rejects.toMatchObject({ code: '23503' });
  });
});

describe('column and table privileges', () => {
  it('API role can write Instagram tokens but can never read them back', async (ctx) => {
    const { app, svc } = need(ctx);
    await withUser(app, A, (tx) => tx`UPDATE social_accounts SET token_ciphertext = ${Buffer.from('secret')}, token_key_id = 'k1', status = 'CONNECTED' WHERE user_id = ${A}`);
    await expect(withUser(app, A, (tx) => tx`SELECT token_ciphertext FROM social_accounts`)).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(app, A, (tx) => tx`SELECT * FROM social_accounts`)).rejects.toMatchObject({ code: '42501' });
    const ok = await withUser(app, A, (tx) => tx`SELECT id, username, status, token_expires_at FROM social_accounts`);
    expect(ok).toHaveLength(1);
    expect((await svc`SELECT token_ciphertext FROM social_accounts WHERE user_id = ${A}`)[0]!.token_ciphertext).toBeTruthy();
  });

  it('API role has no direct access to login attempts, delivery tokens or ai usage writes', async (ctx) => {
    const { app } = need(ctx);
    await expect(withUser(app, A, (tx) => tx`SELECT * FROM login_attempts`)).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(app, A, (tx) => tx`SELECT * FROM delivery_tokens`)).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(app, A, (tx) => tx`INSERT INTO ai_usage_ledger (user_id, provider, model, purpose, est_cost_usd) VALUES (${A}, 'x', 'x', 'x', 1)`)).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(app, A, (tx) => tx`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode) VALUES (${A}, ${pa.versionId}, 'p', 'm', 'v', 'mock')`)).rejects.toMatchObject({ code: '42501' });
  });

  it('API role cannot change the schema or read other databases\' secrets', async (ctx) => {
    const { app } = need(ctx);
    await expect(app`CREATE TABLE hax (id int)`).rejects.toMatchObject({ code: '42501' });
    await expect(app`SELECT * FROM pg_authid`).rejects.toMatchObject({ code: '42501' });
  });

  it('delivery role touches only delivery_tokens (read + hit counter)', async (ctx) => {
    const { delivery, svc } = need(ctx);
    await expect(delivery`SELECT * FROM photos`).rejects.toMatchObject({ code: '42501' });
    await expect(delivery`SELECT * FROM users`).rejects.toMatchObject({ code: '42501' });
    const [d] = await svc`SELECT id FROM publishing_drafts WHERE user_id = ${A}`;
    await svc`UPDATE publishing_drafts SET state='READY', approved_at=now(), approved_by=${A} WHERE id=${d!.id}`;
    const [sp] = await svc`INSERT INTO scheduled_publications (user_id, draft_id, scheduled_at, timezone) VALUES (${A}, ${d!.id}, now() + interval '1 day', 'UTC') RETURNING id`;
    await svc`INSERT INTO delivery_tokens (user_id, scheduled_publication_id, token_hash, file_relpath, expires_at) VALUES (${A}, ${sp!.id}, ${sha(3)}, 'x.jpg', now() + interval '20 minutes')`;
    expect(await delivery`SELECT hits FROM delivery_tokens WHERE token_hash = ${sha(3)}`).toHaveLength(1);
    await delivery`UPDATE delivery_tokens SET hits = hits + 1 WHERE token_hash = ${sha(3)}`;
    await expect(delivery`UPDATE delivery_tokens SET expires_at = now() + interval '30 minutes' WHERE token_hash = ${sha(3)}`).rejects.toMatchObject({ code: '42501' });
    await expect(delivery`DELETE FROM delivery_tokens`).rejects.toMatchObject({ code: '42501' });
  });

  it('backup role can read all users\' rows but cannot write', async (ctx) => {
    const { backup } = need(ctx);
    expect((await backup`SELECT count(*)::int AS n FROM photos`)[0]!.n).toBe(2);
    await expect(backup`DELETE FROM photos`).rejects.toBeTruthy();
    await expect(backup`INSERT INTO collections (user_id, name) VALUES (${A}, 'x')`).rejects.toBeTruthy();
  });
});

describe('authentication functions', () => {
  it('login lookup, session create/resolve/expire/revoke work without a user context', async (ctx) => {
    const { app, svc } = need(ctx);
    const found = await app`SELECT * FROM auth_find_user(${'A@Example.test'})`;   // citext: case-insensitive
    expect(found).toHaveLength(1); expect(found[0]!.id).toBe(A);
    const tok = sha(7);
    const [{ auth_create_session: sid }] = (await app`SELECT auth_create_session(${A}, ${tok}, interval '1 day', '127.0.0.1', 'test')`) as unknown as [{ auth_create_session: string }];
    expect(sid).toBeTruthy();
    expect((await app`SELECT auth_resolve_session(${tok}) AS u`)[0]!.u).toBe(A);
    expect((await app`SELECT auth_resolve_session(${sha(8)}) AS u`)[0]!.u).toBeNull();
    await withUser(app, A, (tx) => tx`UPDATE sessions SET revoked_at = now() WHERE id = ${sid}`);
    expect((await app`SELECT auth_resolve_session(${tok}) AS u`)[0]!.u).toBeNull();
    const tok2 = sha(9);
    await app`SELECT auth_create_session(${A}, ${tok2}, interval '1 day', NULL, NULL)`;
    await svc`UPDATE sessions SET expires_at = now() - interval '1 second', created_at = now() - interval '2 days' WHERE token_hash = ${tok2}`;
    expect((await app`SELECT auth_resolve_session(${tok2}) AS u`)[0]!.u).toBeNull();
  });

  it('a disabled user cannot get or use a session; failures are counted for throttling', async (ctx) => {
    const { app, svc } = need(ctx);
    await svc`UPDATE users SET disabled_at = now() WHERE id = ${A}`;
    expect((await app`SELECT auth_create_session(${A}, ${sha(5)}, interval '1 day', NULL, NULL) AS s`)[0]!.s).toBeNull();
    for (let i = 0; i < 3; i++) await app`SELECT auth_record_login(${B}, '10.0.0.9', false)`;
    expect((await app`SELECT auth_recent_failures(${B}, '10.0.0.9', interval '15 minutes') AS n`)[0]!.n).toBe(3);
  });

  it('sessions of other users are invisible to the API role', async (ctx) => {
    const { app } = need(ctx);
    await app`SELECT auth_create_session(${B}, ${sha(11)}, interval '1 day', NULL, NULL)`;
    const seen = await withUser(app, A, (tx) => tx`SELECT * FROM sessions`);
    expect(seen).toHaveLength(0);
  });

  it('device tokens resolve with scope and respect revocation', async (ctx) => {
    const { app, svc } = need(ctx);
    await svc`INSERT INTO device_tokens (user_id, name, token_hash, scope) VALUES (${A}, 'agent', ${sha(21)}, ARRAY['ingest'])`;
    const r = await app`SELECT * FROM auth_resolve_device(${sha(21)})`;
    expect(r[0]).toMatchObject({ user_id: A, scope: ['ingest'] });
    await svc`UPDATE device_tokens SET revoked_at = now()`;
    expect(await app`SELECT * FROM auth_resolve_device(${sha(21)})`).toHaveLength(0);
    await expect(svc`INSERT INTO device_tokens (user_id, name, token_hash, scope) VALUES (${A}, 'x', ${sha(22)}, ARRAY['admin'])`).rejects.toMatchObject({ code: '23514' });
  });
});

void randomUUID; void seedRoot;
