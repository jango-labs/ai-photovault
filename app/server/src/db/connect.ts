import postgres, { type Sql } from 'postgres';
import { EnvSecretStore, PORTS, type SecretName, type SecretStore, SECRET_ENV } from '@photovault/shared';

/** Database login roles (all least-privilege, none superuser / BYPASSRLS). See migrations/0009_security.sql. */
export type DbRole = 'pv_owner' | 'pv_app' | 'pv_service' | 'pv_delivery' | 'pv_backup';

const PASSWORD_SECRET: Record<DbRole, SecretName> = {
  pv_owner: 'db_owner',
  pv_app: 'db_app',
  pv_service: 'db_service',
  pv_delivery: 'db_delivery',
  pv_backup: 'db_backup',
};

export interface DbTarget {
  host: string;
  port: number;
  database: string;
  user: DbRole;
  password: string;
}

export async function resolveTarget(
  role: DbRole,
  database: string,
  secrets: SecretStore = new EnvSecretStore(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DbTarget> {
  if (!/^photovault[a-z0-9_]*$/.test(database)) throw new Error(`Refusing to connect to non-PhotoVault database "${database}"`);
  const password = await secrets.get(PASSWORD_SECRET[role]);
  if (!password) throw new Error(`No password for database role ${role}. Set ${SECRET_ENV[PASSWORD_SECRET[role]]} (see .env.example)`);
  return {
    host: env.PHOTOVAULT_PGHOST ?? '127.0.0.1',
    port: Number(env.PHOTOVAULT_PGPORT ?? PORTS.postgres),
    database,
    user: role,
    password,
  };
}

export function connect(target: DbTarget, opts: { max?: number; connection?: Record<string, string> } = {}): Sql {
  return postgres({
    host: target.host, port: target.port, database: target.database, username: target.user, password: target.password,
    max: opts.max ?? 5, idle_timeout: 20, connect_timeout: 5, onnotice: () => {},
    ...(opts.connection ? { connection: opts.connection } : {}),
  });
}

/**
 * Runs `fn` in a transaction as the given application user: `SET LOCAL app.user_id` drives row-level security.
 * Every API request that touches user data goes through this.
 */
export async function withUser<T>(sql: Sql, userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user id');
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
