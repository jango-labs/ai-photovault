import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import { withUser } from '../db/connect.js';
import { assertApproved, canonical, loadPolicy } from './approval.js';
import { IngestService, sourceExists, type RunResult } from './service.js';

/**
 * The permanent photograph source (read-only) and its lightweight scheduled scan.
 *   PHOTOVAULT_INGEST_DIR          the folder (also needs an APPLY entry in <state dir>/approvals/ingest.json)
 *   PHOTOVAULT_INGEST_NAME         display name (default: the folder name)
 *   PHOTOVAULT_SCAN_INTERVAL_MIN   minutes between scans by the worker (default 360; 0 = scheduled scanning off; minimum 15)
 * A scan is the importer's own incremental, read-only walk: unchanged files are not read again, nothing is ever deleted.
 */
export interface SourceConfig { name: string; dir: string; intervalMin: number }

export function sourceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SourceConfig | null {
  const dir = env.PHOTOVAULT_INGEST_DIR?.trim(); if (!dir) return null;
  const raw = env.PHOTOVAULT_SCAN_INTERVAL_MIN; const n = raw === undefined || raw === '' ? 360 : Number(raw);
  const intervalMin = !Number.isFinite(n) || n <= 0 ? 0 : Math.max(15, Math.min(Math.floor(n), 7 * 24 * 60));
  return { name: env.PHOTOVAULT_INGEST_NAME?.trim() || path.basename(dir.replace(/\/+$/, '')), dir, intervalMin };
}

/** Is the folder there and readable right now? (a missing or empty-looking source is never scanned) */
export function sourceAvailability(dir: string): { available: boolean; reason: string | null } {
  if (!sourceExists(dir)) return { available: false, reason: 'The folder is not there (is the disk that holds it connected?).' };
  try { if (fs.readdirSync(dir).length === 0) return { available: false, reason: 'The folder is empty.' }; } catch { return { available: false, reason: 'The folder cannot be read by this program.' }; }
  return { available: true, reason: null };
}

export interface SourceInfo {
  name: string; path: string; type: 'Local folder'; mode: 'Read only'; available: boolean; unavailableReason: string | null;
  discovered: number | null; imported: number; skipped: number; lastScanAt: string | null; lastScanState: string | null; lastRunAt: string | null; lastRunState: string | null; lastError: string | null;
  scanIntervalMinutes: number; nextScanAt: string | null; scanning: boolean;
  lastScan: { new: number; unchanged: number; moved: number; skipped: number; failed: number; missing: number; duplicates: number } | null;
}

interface RunRowLite { state: string; mode: string; finished_at: Date | null; started_at: Date; counters: Record<string, unknown> | null; error: string | null; heartbeat_at: Date }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sumSkipped = (c: Record<string, unknown> | null) => Object.values((c?.skipped ?? {}) as Record<string, unknown>).reduce<number>((a, b) => a + num(b), 0);

export async function sourceInfo(sql: Sql, userId: string, cfg: SourceConfig, now = new Date()): Promise<SourceInfo> {
  const avail = sourceAvailability(cfg.dir); const root = canonical(cfg.dir);
  const { runs, imported } = await withUser(sql, userId, async (tx) => {
    const runs = await tx<RunRowLite[]>`SELECT state, mode, finished_at, started_at, counters, error, heartbeat_at FROM import_runs WHERE source_path = ${root} ORDER BY started_at DESC LIMIT 20`;
    const [i] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM photo_versions v JOIN library_roots r ON r.id = v.library_root_id WHERE r.path = ${root} AND v.state = 'ACTIVE'`;
    return { runs, imported: i?.n ?? 0 };
  });
  const last = runs[0] ?? null; const lastDone = runs.find((r) => r.state === 'COMPLETED') ?? null; const lastApply = runs.find((r) => r.state === 'COMPLETED' && r.mode === 'APPLY') ?? null;
  const scanning = !!last && last.state === 'RUNNING' && now.getTime() - last.heartbeat_at.getTime() < 120_000;
  const c = lastDone?.counters ?? null;
  const next = cfg.intervalMin > 0 && avail.available ? new Date(Math.max(now.getTime(), (lastApply?.finished_at ?? now).getTime() + cfg.intervalMin * 60_000)) : null;
  return {
    name: cfg.name, path: cfg.dir, type: 'Local folder', mode: 'Read only', available: avail.available, unavailableReason: avail.reason,
    discovered: c ? num(c.scanned) : null, imported, skipped: sumSkipped(c), lastScanAt: lastApply?.finished_at?.toISOString() ?? null, lastScanState: lastApply ? 'COMPLETED' : null,
    lastRunAt: last?.started_at.toISOString() ?? null, lastRunState: last?.state ?? null, lastError: last && last.state !== 'COMPLETED' && last.state !== 'RUNNING' ? last.error : null,
    scanIntervalMinutes: cfg.intervalMin, nextScanAt: next?.toISOString() ?? null, scanning,
    lastScan: c ? { new: num(c.new), unchanged: num(c.unchanged), moved: num(c.moved), skipped: sumSkipped(c), failed: num(c.errors), missing: num(c.missing), duplicates: num(c.duplicateFiles) } : null,
  };
}

export interface ScanDeps { sql: Sql; cfg: SourceConfig; stateDir: string; derivativesDir: string | null; now?: () => Date; log?: (m: string) => void }
export type ScanOutcome = { ran: false; reason: string } | { ran: true; result: RunResult };

/**
 * One scheduled-scan decision. Never throws. Skips (and says why) when scanning is off, the source is unavailable or looks empty while the library has
 * photographs, the owner has not approved importing from it, another run is active, or the last scan is recent.
 */
export async function scheduledScan(d: ScanDeps): Promise<ScanOutcome> {
  const { sql, cfg } = d; const now = (d.now ?? (() => new Date()))();
  try {
    if (cfg.intervalMin <= 0) return { ran: false, reason: 'scheduled scanning is off' };
    const avail = sourceAvailability(cfg.dir);
    if (!avail.available) {
      // an empty-looking source while photographs are recorded is far more likely a missing disk than a deleted library: do not scan
      return { ran: false, reason: `source unavailable: ${avail.reason}` };
    }
    try { assertApproved(loadPolicy(d.stateDir), cfg.dir, 'APPLY'); } catch { return { ran: false, reason: 'importing from this folder has not been approved' }; }
    const owner = (await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`)[0]?.id; if (!owner) return { ran: false, reason: 'no account' };
    const ingest = new IngestService({ sql, policy: loadPolicy(d.stateDir), derivativesDir: d.derivativesDir });
    await ingest.recover(owner);
    const root = canonical(cfg.dir);
    const state = await withUser(sql, owner, async (tx) => {
      const [busy] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM import_runs WHERE state = 'RUNNING' AND heartbeat_at > now() - interval '120 seconds'`;
      const [ok] = await tx<{ at: Date | null }[]>`SELECT max(finished_at) AS at FROM import_runs WHERE state = 'COMPLETED' AND mode = 'APPLY' AND source_path = ${root}`;
      const [any] = await tx<{ at: Date | null }[]>`SELECT max(started_at) AS at FROM import_runs WHERE source_path = ${root}`;
      return { busy: (busy?.n ?? 0) > 0, ok: ok?.at ?? null, any: any?.at ?? null };
    });
    if (state.busy) return { ran: false, reason: 'an import is already running' };
    if (state.ok && now.getTime() - state.ok.getTime() < cfg.intervalMin * 60_000) return { ran: false, reason: 'the last scan is recent' };
    if (state.any && now.getTime() - state.any.getTime() < Math.min(cfg.intervalMin, 15) * 60_000) return { ran: false, reason: 'a scan was attempted a moment ago' };
    d.log?.(`scheduled scan of ${cfg.name} starting`);
    const result = await ingest.run(owner, cfg.dir, 'APPLY');
    d.log?.(`scheduled scan ${result.state}: ${result.counters.new} new, ${result.counters.moved} moved, ${result.counters.unchanged} unchanged, ${result.counters.errors} failed`);
    return { ran: true, result };
  } catch (e) {
    d.log?.(`scheduled scan could not run: ${e instanceof Error ? e.message : String(e)}`);
    return { ran: false, reason: 'the scan could not start' };
  }
}
