import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { resolveTarget } from './connect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

export interface MigrateOptions {
  database: string;
  direction: 'up' | 'down';
  /** number of migrations; omit for "all" on up, required on down unless `all` */
  count?: number;
  all?: boolean;
}

/** Applies/reverts SQL migrations as pv_owner (the only role that may change the schema). */
export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const target = await resolveTarget('pv_owner', opts.database);
  const result = await runner({
    databaseUrl: { host: target.host, port: target.port, database: target.database, user: target.user, password: target.password },
    dir: MIGRATIONS_DIR,
    direction: opts.direction,
    migrationsTable: 'schema_migrations',
    checkOrder: true,
    ...(opts.count !== undefined ? { count: opts.count } : opts.direction === 'down' && opts.all ? { count: Infinity } : {}),
    log: () => {},
  });
  return result.map((m) => m.name);
}

async function cli() {
  const [cmd = 'up', ...rest] = process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const database = flag('db') ?? process.env.PHOTOVAULT_DB ?? 'photovault';
  if (cmd === 'up') {
    const names = await migrate({ database, direction: 'up' });
    console.log(names.length ? `applied ${names.length}: ${names.join(', ')}` : 'already up to date');
  } else if (cmd === 'down') {
    const count = flag('count');
    if (!count && !rest.includes('--all')) throw new Error('down requires --count N or --all');
    const names = await migrate({ database, direction: 'down', ...(count ? { count: Number(count) } : { all: true }) });
    console.log(`reverted ${names.length}: ${names.join(', ')}`);
  } else {
    throw new Error('usage: migrate up|down [--db name] [--count N | --all]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
