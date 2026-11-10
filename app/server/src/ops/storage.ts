import fs from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';

/**
 * What the system occupies and how healthy its housekeeping is: database and table sizes, the folders that grow with the library (previews,
 * Instagram images, delivery copies, backups) and the free space of the volumes they sit on, plus the age of the newest verified backup and
 * the heartbeat of each background process. Read-only; never touches a photograph.
 */
export interface DirUsage { key: string; label: string; path: string | null; bytes: number | null; files: number | null; freeBytes: number | null; totalBytes: number | null; truncated: boolean }
const WALK_LIMIT = 300_000, WALK_MS = 2500;

export async function dirUsage(root: string, deadline = Date.now() + WALK_MS): Promise<{ bytes: number; files: number; truncated: boolean }> {
  let bytes = 0, files = 0, seen = 0, truncated = false; const stack = [root];
  while (stack.length) {
    const d = stack.pop()!; let ents: import('node:fs').Dirent[]; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > WALK_LIMIT || Date.now() > deadline) { truncated = true; return { bytes, files, truncated }; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.isFile()) { try { bytes += (await fs.stat(p)).size; files++; } catch { /* vanished */ } }
    }
  }
  return { bytes, files, truncated };
}
async function free(p: string): Promise<{ free: number; total: number } | null> { try { const s = await fs.statfs(p); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; } catch { return null; } }

export interface StorageDirs { derivatives: string | null; igMedia: string | null; delivery: string | null; backups: string | null; state: string | null }
export async function storageReport(sql: Sql, dirs: StorageDirs) {
  const [db] = await sql<{ bytes: string }[]>`SELECT pg_database_size(current_database())::text AS bytes`;
  const tables = await sql<{ name: string; bytes: string; rows: string }[]>`
    SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes, greatest(c.reltuples, 0)::bigint::text AS rows
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`;
  const spec: Array<[keyof StorageDirs, string]> = [['derivatives', 'Previews'], ['igMedia', 'Instagram images'], ['delivery', 'Publish copies (temporary)'], ['backups', 'Backups'], ['state', 'State, logs and PostgreSQL cluster']];
  const out: DirUsage[] = [];
  for (const [key, label] of spec) {
    const p = dirs[key]; if (!p) { out.push({ key, label, path: null, bytes: null, files: null, freeBytes: null, totalBytes: null, truncated: false }); continue; }
    const [u, f] = await Promise.all([dirUsage(p), free(p)]);
    out.push({ key, label, path: p, bytes: u.bytes, files: u.files, freeBytes: f?.free ?? null, totalBytes: f?.total ?? null, truncated: u.truncated });
  }
  return { database: { bytes: Number(db!.bytes), tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes), rows: Number(t.rows) })) }, dirs: out };
}

/** The off-device copies the owner relies on. `maxAgeSeconds` is how old the newest SUCCESSFUL run may be before it is called stale. */
const OFFSITE: Array<{ kind: string; key: string; label: string; maxAgeSeconds: number; what: string; optional?: boolean }> = [
  { kind: 'NAS_COPY', key: 'nasCopy', label: 'Copy of verified backups to the NAS', maxAgeSeconds: 13 * 3600, what: 'verified database backup on the NAS' },
  { kind: 'NAS_RESTORE_TEST', key: 'nasRestoreTest', label: 'Restore test from the NAS copy (monthly)', maxAgeSeconds: 40 * 86_400, what: 'restore test from the NAS copy' },
  { kind: 'CONFIG_BUNDLE', key: 'configBundle', label: 'Configuration bundle on the NAS (weekly)', maxAgeSeconds: 9 * 86_400, what: 'configuration bundle on the NAS' },
  { kind: 'ESCROW', key: 'escrow', label: 'Encrypted recovery-secret escrow (weekly)', maxAgeSeconds: 9 * 86_400, what: 'encrypted recovery-secret escrow file' },
  // shown only once an original-photograph backup has been run at least once (no schedule exists until the owner approves one)
  { kind: 'ORIGINALS_COPY', key: 'originalsCopy', label: 'Original photographs on the NAS (add-only)', maxAgeSeconds: 2 * 86_400, what: 'verified copy of the original photographs on the NAS', optional: true },
];
export type OffsiteState = 'ok' | 'stale' | 'failed' | 'never';

export async function opsStatus(sql: Sql, now = new Date()) {
  const beats = await sql<{ service: string; instance: string; at: Date; version: string | null }[]>`SELECT service, instance, at, version FROM service_heartbeats ORDER BY service`;
  const services = beats.map((b) => { const age = Math.max(0, Math.round((now.getTime() - b.at.getTime()) / 1000)); return { name: b.service, instance: b.instance, version: b.version, lastSeenAt: b.at.toISOString(), ageSeconds: age, status: age <= 90 ? 'running' : age <= 600 ? 'late' : 'stopped' }; });
  const run = async (kind: string, verified: boolean) => (await sql<{ finished_at: Date | null; ok: boolean | null; bytes: string | null; verify_ok: boolean | null; verified_at: Date | null }[]>`
    SELECT finished_at, ok, bytes::text AS bytes, verify_ok, verified_at FROM backup_runs WHERE kind = ${kind} AND ok ${verified ? sql`AND verify_ok` : sql``} ORDER BY coalesce(finished_at, started_at) DESC LIMIT 1`)[0] ?? null;
  const dump = await run('DUMP', true); const test = await run('RESTORE_TEST', true);
  const age = (d: Date | null | undefined) => (d ? Math.round((now.getTime() - d.getTime()) / 1000) : null);
  const lastDumpAge = age(dump?.finished_at);
  // Off-device protection: for each kind, the newest success, and the newest attempt of any outcome (a later failure is shown even if an older success exists).
  const checks = [];
  for (const o of OFFSITE) {
    if (o.optional && !(await sql`SELECT 1 FROM backup_runs WHERE kind = ${o.kind} LIMIT 1`).length) continue;
    const good = (await sql<{ finished_at: Date | null; bytes: string | null }[]>`SELECT finished_at, bytes::text AS bytes FROM backup_runs WHERE kind = ${o.kind} AND ok AND verify_ok ORDER BY coalesce(finished_at, started_at) DESC LIMIT 1`)[0] ?? null;
    const last = (await sql<{ finished_at: Date | null; ok: boolean | null; detail: { error?: string } }[]>`SELECT finished_at, ok, detail FROM backup_runs WHERE kind = ${o.kind} ORDER BY coalesce(finished_at, started_at) DESC LIMIT 1`)[0] ?? null;
    const goodAge = age(good?.finished_at); const failedLast = !!last && last.ok === false;
    const state: OffsiteState = failedLast ? 'failed' : goodAge === null ? 'never' : goodAge > o.maxAgeSeconds ? 'stale' : 'ok';
    checks.push({ key: o.key, label: o.label, state, lastOkAt: good?.finished_at?.toISOString() ?? null, lastOkAgeSeconds: goodAge, lastFailure: failedLast ? { at: last!.finished_at?.toISOString() ?? null, message: String(last!.detail?.error ?? 'failed').slice(0, 300) } : null, maxAgeSeconds: o.maxAgeSeconds });
  }
  const problems = checks.filter((c) => c.state !== 'ok').map((c) => {
    const o = OFFSITE.find((x) => x.key === c.key)!;
    return c.state === 'failed' ? `${c.label}: the last attempt failed — ${c.lastFailure!.message}` : c.state === 'never' ? `${c.label}: has never completed — there is no ${o.what} yet` : `${c.label}: the newest success is too old (limit ${Math.round(o.maxAgeSeconds / 3600)} h)`;
  });
  return {
    services,
    backups: { lastVerifiedDump: dump ? { at: dump.finished_at?.toISOString() ?? null, ageSeconds: lastDumpAge, bytes: dump.bytes ? Number(dump.bytes) : null } : null, lastRestoreTest: test ? { at: test.finished_at?.toISOString() ?? null, ageSeconds: age(test.finished_at) } : null, stale: lastDumpAge === null || lastDumpAge > 86_400 },
    offsite: { checks, problems, healthy: problems.length === 0 },
  };
}
