import { randomUUID, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { connect, resolveTarget, withUser, type DbRole } from './connect.js';
import { migrate } from './migrate.js';

export const TEST_DB = 'photovault_test';
export interface Handles { owner: Sql; svc: Sql; app: Sql; delivery: Sql; backup: Sql; close(): Promise<void> }

/** Connects as every role to the throw-away test database, migrated to head. Returns null when Postgres is not reachable. */
export async function tryHandles(): Promise<Handles | null> {
  try {
    await migrate({ database: TEST_DB, direction: 'up' });
    const mk = async (r: DbRole) => connect(await resolveTarget(r, TEST_DB), { max: 4 });
    const [owner, svc, app, delivery, backup] = await Promise.all((['pv_owner', 'pv_service', 'pv_app', 'pv_delivery', 'pv_backup'] as DbRole[]).map(mk));
    const h = { owner: owner!, svc: svc!, app: app!, delivery: delivery!, backup: backup! };
    await h.svc`SELECT 1`;
    return { ...h, close: async () => { await Promise.all(Object.values(h).map((s) => s.end({ timeout: 2 }))); } };
  } catch (e) {
    console.warn(`[db tests] skipped: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Removes all test data: deleting users cascades through every user-owned table. */
export async function wipe(svc: Sql): Promise<void> {
  await svc`DELETE FROM users`;
  await svc`DELETE FROM login_attempts`;      // attempts for unknown e-mails have no user to cascade from
  await svc`DELETE FROM service_heartbeats`;
  await svc`DELETE FROM backup_runs`;
}

export const sha = (n = 1) => Buffer.alloc(32, n);

export async function seedUser(svc: Sql, email = `${randomUUID()}@example.test`): Promise<string> {
  const [u] = await svc<{ id: string }[]>`INSERT INTO users (email, password_hash) VALUES (${email}, 'x') RETURNING id`;
  return u!.id;
}

export async function seedRoot(svc: Sql, userId: string): Promise<string> {
  const [r] = await svc<{ id: string }[]>`
    INSERT INTO library_roots (user_id, path) VALUES (${userId}, ${'/tmp/photovault-test/' + randomUUID()}) RETURNING id`;
  return r!.id;
}

export interface SeededPhoto { photoId: string; versionId: string; rootId: string }
/** One logical photo with one ACTIVE version, created in a single transaction (current_version_id FK is deferred). */
export async function seedPhoto(svc: Sql, userId: string, o: { rootId?: string; relpath?: string; seed?: number; phash?: bigint | null; title?: string } = {}): Promise<SeededPhoto> {
  const rootId = o.rootId ?? (await seedRoot(svc, userId));
  const photoId = randomUUID(); const versionId = randomUUID();
  const relpath = o.relpath ?? `2026/Kenya/${randomBytes(4).toString('hex')}.jpg`;
  await svc.begin(async (tx) => {
    await tx`INSERT INTO photos (id, user_id, current_version_id, title, title_source) VALUES (${photoId}, ${userId}, ${versionId}, ${o.title ?? null}, ${o.title ? 'USER_DEFINED' : null})`;
    await tx`INSERT INTO photo_versions (id, user_id, photo_id, version_no, library_root_id, source_relpath, content_sha256, phash, state, width, height, bytes)
             VALUES (${versionId}, ${userId}, ${photoId}, 1, ${rootId}, ${relpath}, ${randomBytes(32)}, ${o.phash == null ? null : o.phash.toString()}::bigint, 'ACTIVE', 6000, 4000, 12345678)`;
  });
  return { photoId, versionId, rootId };
}

export { withUser };
