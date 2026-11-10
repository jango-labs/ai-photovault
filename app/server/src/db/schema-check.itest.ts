import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationFiles, pendingMessage, pendingMigrations } from './schema-check.js';
import { tryHandles, type Handles } from './testdb.js';

let h: Handles | null;
beforeAll(async () => { h = await tryHandles(); });
afterAll(async () => { await h?.close(); });

describe('start-up schema check', () => {
  it('a migrated database has nothing pending, and the build ships every migration it needs', async (ctx) => {
    if (!h) return ctx.skip(); expect(migrationFiles().length).toBeGreaterThanOrEqual(19); expect(await pendingMigrations(h.svc)).toEqual([]);
  });
  it('a build that knows migrations the database lacks is told exactly which, with the fix', async (ctx) => {
    if (!h) return ctx.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-mig-')); try {
      for (const f of migrationFiles()) fs.writeFileSync(path.join(dir, `${f}.sql`), '-- x'); fs.writeFileSync(path.join(dir, '0099_future.sql'), '-- x'); fs.writeFileSync(path.join(dir, '0100_further.sql'), '-- x');
      const pending = await pendingMigrations(h.svc, dir); expect(pending).toEqual(['0099_future', '0100_further']);
      const msg = pendingMessage('photovault', pending); expect(msg).toContain('2 migration(s) not applied'); expect(msg).toContain('0099_future'); expect(msg).toContain('db:migrate'); expect(msg).toContain('verified backup');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('a database too old to even show its migration list to the application counts as behind', async (ctx) => {
    if (!h) return ctx.skip();
    await h.owner`REVOKE SELECT ON schema_migrations FROM pv_app`;
    try { expect((await pendingMigrations(h.app)).length).toBeGreaterThan(0); expect(await pendingMigrations(h.app)).toContain('0020_schema_version_visible'); }
    finally { await h.owner`GRANT SELECT ON schema_migrations TO pv_app`; }
    expect(await pendingMigrations(h.app)).toEqual([]);
  });
  it('is wired into the server start-up before it listens', () => {
    const main = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../main.ts'), 'utf8');
    expect(main.indexOf('pendingMigrations(sql)')).toBeGreaterThan(0); expect(main.indexOf('pendingMigrations(sql)')).toBeLessThan(main.indexOf('app.listen')); expect(main).toContain('process.exit(78)');
  });
});
