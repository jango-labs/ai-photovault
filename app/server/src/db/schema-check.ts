import fs from 'node:fs';
import type { Sql } from 'postgres';
import { MIGRATIONS_DIR } from './migrate.js';

/**
 * Refuses to run code against a database that is behind it. A build always ships with the migrations it needs; if some are not applied (a restart
 * after an unreleased build was copied over a running installation, a restored older backup) the application would fail in confusing ways, so it
 * stops at start-up with the exact list and the fix.
 */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] { return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort(); }
export async function pendingMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  let applied: Set<string>;
  try { applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name)); }
  catch (e) {
    // a database older than migration 0020 does not let this role read the list at all — which is itself proof that it is behind this build
    if ((e as { code?: string }).code === '42501') return migrationFiles(dir).filter((n) => n >= '0020');
    throw e;
  }
  return migrationFiles(dir).filter((n) => !applied.has(n));
}
export const pendingMessage = (database: string, pending: string[]) =>
  `The database "${database}" is behind this build: ${pending.length} migration(s) not applied (${pending.slice(0, 4).join(', ')}${pending.length > 4 ? ', …' : ''}). Take a verified backup, then run: npm run db:migrate (see docs/PRODUCTION_DEPLOYMENT.md).`;
