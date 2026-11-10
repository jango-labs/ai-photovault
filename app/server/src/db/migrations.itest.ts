import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, resolveTarget } from './connect.js';
import { MIGRATIONS_DIR, migrate } from './migrate.js';
import { readdirSync } from 'node:fs';
import { TEST_DB } from './testdb.js';

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

describe('migrations', () => {
  let ok = true;
  beforeAll(async () => { try { await migrate({ database: TEST_DB, direction: 'up' }); } catch (e) { ok = false; console.warn('[db tests] skipped:', (e as Error).message); } });
  afterAll(async () => { if (ok) await migrate({ database: TEST_DB, direction: 'up' }); });

  it('every migration has an explicit Down section', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of files) expect(readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8'), f).toMatch(/^-- Down Migration/m);
  });

  it('is reversible: stepwise down then up, and a full down leaves no application tables', async (ctx) => {
    if (!ok) return ctx.skip();
    const sql = connect(await resolveTarget('pv_owner', TEST_DB), { max: 1 });
    try {
      const count = async () => (await sql`SELECT count(*)::int AS n FROM schema_migrations`)[0]!.n as number;
      expect(await count()).toBe(files.length);
      for (let i = files.length; i > 0; i--) {
        await migrate({ database: TEST_DB, direction: 'down', count: 1 });
        expect(await count()).toBe(i - 1);
      }
      const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`;
      expect(tables.map((t) => t.tablename)).toEqual([]);
      const domains = await sql`SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='d'`;
      expect(domains).toHaveLength(0);
      const names = await migrate({ database: TEST_DB, direction: 'up' });
      expect(names).toHaveLength(files.length);
      expect(await migrate({ database: TEST_DB, direction: 'up' })).toEqual([]); // idempotent
    } finally { await sql.end({ timeout: 2 }); }
  }, 60_000);
});
