import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Is this computer too short of memory or disk to start more heavy (local AI) work right now? Answers with the reason, or null when all is well.
 * Memory uses the operating system's own pressure level (1 normal, 2 warning, 4 critical), not "free memory", which is misleading on macOS.
 * Disk looks at the photo drive's data folder (previews and AI assets) and at the disk that holds the database. Cached for ten seconds.
 */
export interface PressureProbes { memoryLevel: () => Promise<number>; freeBytes: (dir: string) => Promise<number> }
export const systemProbes: PressureProbes = {
  memoryLevel: async () => { try { const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']); const n = Number(stdout.trim()); return Number.isFinite(n) ? n : 1; } catch { return 1; } },
  freeBytes: async (dir) => { const s = await fs.statfs(dir); return s.bavail * s.bsize; },
};
export interface PressureOptions { dirs: Array<{ label: string; path: string; minFreeGb: number }>; probes?: PressureProbes; ttlMs?: number; now?: () => number }

export function resourcePressure(o: PressureOptions): () => Promise<string | null> {
  const p = o.probes ?? systemProbes; const ttl = o.ttlMs ?? 10_000; const now = o.now ?? Date.now; let cache: { at: number; v: string | null } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttl) return cache.v;
    let v: string | null = null;
    const level = await p.memoryLevel();
    if (level >= 2) v = level >= 4 ? 'this computer is critically short of memory' : 'this computer is short of memory';
    for (const d of o.dirs) {
      if (v) break;
      try { const free = await p.freeBytes(d.path); if (free < d.minFreeGb * 1e9) v = `less than ${d.minFreeGb} GB free on ${d.label}`; } catch { /* a missing folder is the storage gate's business, not this one's */ }
    }
    cache = { at: now(), v }; return v;
  };
}
