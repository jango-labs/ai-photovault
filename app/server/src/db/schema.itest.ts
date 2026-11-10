import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryHandles, type Handles } from './testdb.js';

let h: Handles | null;
beforeAll(async () => { h = await tryHandles(); });
afterAll(async () => { await h?.close(); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); return h!; };

const AUTH_TABLES = ['sessions', 'device_tokens', 'login_attempts', 'users'];
const SYSTEM_TABLES = ['service_heartbeats', 'backup_runs', 'schema_migrations'];

describe('schema validation', () => {
  it('contains every approved entity', async (ctx) => {
    const { svc } = need(ctx);
    const t = (await svc`SELECT tablename FROM pg_tables WHERE schemaname='public'`).map((r) => r.tablename as string);
    for (const name of ['photos', 'photo_versions', 'collections', 'collection_photos', 'locations', 'species', 'photo_species',
      'ai_analyses', 'photo_embeddings', 'social_accounts', 'social_posts', 'social_post_media', 'photo_social_matches',
      'publishing_drafts', 'scheduled_publications', 'publication_attempts', 'sync_events', 'caption_versions', 'jobs', 'delivery_tokens'])
      expect(t, name).toContain(name);
  });

  it('every table has a primary key', async (ctx) => {
    const { svc } = need(ctx);
    const rows = await svc`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p')`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('every user-owned table has user_id NOT NULL, RLS enabled and an API-role policy', async (ctx) => {
    const { svc } = need(ctx);
    const rows = await svc`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND 'pv_app'::regrole = ANY (p.polroles::regrole[])) AS has_app_policy,
             (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='user_id') AS user_id_not_null
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`;
    for (const r of rows) {
      if (SYSTEM_TABLES.includes(r.relname)) continue;
      const hasUserId = r.user_id_not_null !== null || r.relname === 'users';
      expect(hasUserId, `${r.relname} lacks user_id`).toBe(true);
      expect(r.rls, `${r.relname} RLS`).toBe(true);
      expect(r.has_app_policy, `${r.relname} app policy`).toBe(true);
      if (!AUTH_TABLES.includes(r.relname)) expect(r.forced, `${r.relname} FORCE RLS`).toBe(true);
      // login_attempts.user_id is nullable on purpose: failed logins for unknown emails have no user
      if (r.user_id_not_null !== null && r.relname !== 'login_attempts') expect(r.user_id_not_null, `${r.relname}.user_id NOT NULL`).toBe(true);
    }
  });

  it('runtime roles are least-privilege: no superuser, no BYPASSRLS, no role/db creation', async (ctx) => {
    const { svc } = need(ctx);
    const rows = await svc`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname LIKE 'pv\\_%'`;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) expect([r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication], r.rolname).toEqual([false, false, false, false, false]);
  });

  it('PUBLIC has no privileges on application tables or functions', async (ctx) => {
    const { svc } = need(ctx);
    const t = await svc`SELECT table_name FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_schema='public'`;
    expect(t).toHaveLength(0);
    const f = await svc`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE ANY (ARRAY['auth\\_%','claim\\_jobs']) AND has_function_privilege('public', p.oid, 'EXECUTE')`;
    expect(f).toHaveLength(0);
  });

  it('timestamps are timestamptz and there are no unbounded surprises', async (ctx) => {
    const { svc } = need(ctx);
    const bad = await svc`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name <> 'schema_migrations' AND data_type='timestamp without time zone' AND NOT (table_name='photos' AND column_name='capture_local')`;     // capture_local is the camera's wall clock on purpose (no zone)
    expect(bad).toHaveLength(0);
  });

  it('every foreign key is supported by an index led by its referencing column(s)', async (ctx) => {
    const { svc } = need(ctx);
    // For composite (user_id, x_id) keys the selective column is x_id, so an index led by x_id (or by both) is sufficient.
    const rows = await svc`
      WITH fks AS (
        SELECT c.conrelid, c.conname, (SELECT array_agg(k ORDER BY k) FROM unnest(c.conkey) k) AS all_cols,
               CASE WHEN cardinality(c.conkey) > 1
                    THEN ARRAY(SELECT k FROM unnest(c.conkey) k WHERE (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = k) <> 'user_id')
                    ELSE c.conkey::int2[] END AS lead_cols
          FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace)
      SELECT conrelid::regclass::text AS tbl, conname,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = fks.conrelid AND i.indisvalid
                       AND ((i.indkey::int2[])[0] = ANY (fks.lead_cols)
                         OR (SELECT array_agg(k ORDER BY k) FROM unnest((i.indkey::int2[])[0:cardinality(fks.all_cols) - 1]) k) = fks.all_cols)) AS covered
        FROM fks`;
    expect(rows.filter((r) => !r.covered).map((r) => `${r.tbl}.${r.conname}`)).toEqual([]);
  });

  it('pgvector is available at a version that supports halfvec + HNSW', async (ctx) => {
    const { svc } = need(ctx);
    const [{ extversion }] = (await svc`SELECT extversion FROM pg_extension WHERE extname='vector'`) as unknown as [{ extversion: string }];
    const [maj, min] = extversion.split('.').map(Number) as [number, number];
    expect(maj > 0 || min >= 7).toBe(true);
  });

  it('has no reference to Base44 anywhere in the catalog', async (ctx) => {
    const { svc } = need(ctx);
    const rows = await svc`SELECT 1 FROM pg_class WHERE relname ILIKE '%base44%' UNION ALL SELECT 1 FROM pg_attribute WHERE attname ILIKE '%base44%'`;
    expect(rows).toHaveLength(0);
  });
});
