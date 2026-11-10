import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Optional "mounted storage" guard for photo derivatives (thumbnails, previews, AI assets, caches): an external drive or a NAS share.
 *
 * Why it exists: if a drive or network share is not mounted, its mount folder is often just an empty directory on the internal disk.
 * Writing there would silently fill the wrong disk. The storage is therefore usable only when ALL of these hold:
 *   1. the configured mount folder exists and is writable (and, when a boot-device check is configured, is on another device than `/`);
 *   2. it contains the data folder with a marker file naming the same storage id (written once by `npm run storage:init`).
 * Anything else yields a plain reason; callers stop (workers pause, the API answers 503) instead of writing somewhere else.
 * This module never formats, moves or deletes anything.
 */
export const MARKER = '.photovault-data-root.json';
export type DataDir = 'derivatives' | 'ai-assets' | 'cache' | 'ig-media' | 'delivery';

export interface VolumeInfo { mountPoint: string | null; writable: boolean; uuid: string }
export type VolumeProbe = (uuid: string) => Promise<VolumeInfo | null>;

export class StorageUnavailableError extends Error {
  constructor(public readonly reason: string) { super(`The photo storage drive is not available: ${reason}`); this.name = 'StorageUnavailableError'; }
}
export interface DataRootStatus { ready: boolean; reason: string | null; root: string | null; mountPoint: string | null; storageId: string }

/** Probe for a configured mount folder: connected = exists; writable = write access. Platform independent (Linux, macOS, Windows, Docker). */
export const pathProbe = (mount: string): VolumeProbe => async (id) => {
  try {
    if (!(await fs.stat(mount)).isDirectory()) return null;
    let writable = true; try { await fs.access(mount, fs.constants.W_OK); } catch { writable = false; }
    return { uuid: id, mountPoint: mount, writable };
  } catch { return null; }
};

export interface DataRootOptions { storageId: string; subdir?: string; probe?: VolumeProbe; ttlMs?: number; now?: () => number; bootDevice?: () => Promise<number> }

export class DataRoot {
  private readonly uuid: string; private readonly subdir: string; private readonly probe: VolumeProbe; private readonly ttl: number; private readonly now: () => number; private readonly boot: (() => Promise<number>) | null;
  private cache: { at: number; status: DataRootStatus } | null = null;
  constructor(o: DataRootOptions) {
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(o.storageId)) throw new Error('PHOTOVAULT_STORAGE_ID must be 8 to 64 letters, digits, dots, dashes or underscores (it is written into the marker file by `npm run storage:init`)');
    if (o.subdir && (path.isAbsolute(o.subdir) || o.subdir.split(/[\\/]/).includes('..'))) throw new Error('the data folder must be a plain relative name');
    this.uuid = o.storageId.toUpperCase(); this.subdir = o.subdir ?? 'PhotoVaultData'; this.probe = o.probe ?? (async () => null); this.ttl = o.ttlMs ?? 3000; this.now = o.now ?? Date.now;
    this.boot = o.bootDevice ?? null;
  }

  /** Current state (cached for a few seconds so a busy API does not shell out per request). */
  async status(fresh = false): Promise<DataRootStatus> {
    if (!fresh && this.cache && this.now() - this.cache.at < this.ttl) return this.cache.status;
    const status = await this.compute(); this.cache = { at: this.now(), status }; return status;
  }
  private async compute(): Promise<DataRootStatus> {
    const base = { storageId: this.uuid, root: null as string | null, mountPoint: null as string | null };
    const no = (reason: string): DataRootStatus => ({ ...base, ready: false, reason });
    const v = await this.probe(this.uuid);
    if (!v) return no('the drive is not connected');
    if (!v.mountPoint) return no('the drive is connected but not mounted');
    base.mountPoint = v.mountPoint;
    if (!v.writable) return no('the drive is mounted read-only');
    if (this.boot) { try { const [m, b] = [(await fs.stat(v.mountPoint)).dev, await this.boot()]; if (m === b) return no('the mount folder is on the internal disk, not on the external drive'); }
      catch { return no('the mount folder cannot be read'); } }
    const root = path.join(v.mountPoint, this.subdir);
    try { if (!(await fs.stat(root)).isDirectory()) return no('the data folder is not a folder'); } catch { return no(`the data folder "${this.subdir}" does not exist on the drive (run: npm run storage:init)`); }
    try {
      const m = JSON.parse(await fs.readFile(path.join(root, MARKER), 'utf8')) as { storageId?: string; version?: number };
      if (m.version !== 1 || String(m.storageId).toUpperCase() !== this.uuid) return no('the data folder belongs to a different drive (marker mismatch)');
    } catch { return no('the data folder has no valid marker file (run: npm run storage:init)'); }
    return { ...base, ready: true, reason: null, root };
  }

  /** The root path, or a StorageUnavailableError with the reason. */
  async require(): Promise<string> {
    const s = await this.status();
    if (!s.ready || !s.root) throw new StorageUnavailableError(s.reason ?? 'unknown');
    return s.root;
  }
  async dir(name: DataDir): Promise<string> { return path.join(await this.require(), name); }
  /** null while ready, otherwise the reason: the form a job worker polls. */
  async gate(): Promise<string | null> { const s = await this.status(); return s.ready ? null : (s.reason ?? 'unavailable'); }
}

/**
 * Builds the resolver from the environment, or null when no mounted-storage guard is configured (then the plain path settings apply).
 *   PHOTOVAULT_STORAGE_MOUNT   the mount folder of the external drive / NAS share
 *   PHOTOVAULT_STORAGE_ID      an id of your choosing, written into the marker file by `npm run storage:init`
 *   PHOTOVAULT_STORAGE_REQUIRE_SEPARATE_DEVICE=1   also refuse a mount folder that lives on the same device as `/`
 */
export function dataRootFromEnv(env: NodeJS.ProcessEnv = process.env, probe?: VolumeProbe): DataRoot | null {
  const id = env.PHOTOVAULT_STORAGE_ID?.trim(); const mount = env.PHOTOVAULT_STORAGE_MOUNT?.trim();
  if (!id || !mount) return null;
  const sep = env.PHOTOVAULT_STORAGE_REQUIRE_SEPARATE_DEVICE === '1';
  return new DataRoot({ storageId: id, probe: probe ?? pathProbe(mount), ...(sep ? { bootDevice: async () => (await fs.stat('/')).dev } : {}), ...(env.PHOTOVAULT_DATA_SUBDIR ? { subdir: env.PHOTOVAULT_DATA_SUBDIR } : {}) });
}
