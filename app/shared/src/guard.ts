import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class UnsafeLibraryRootError extends Error {}

export const RAW_EXT = new Set(['.nef', '.nrw', '.cr2', '.cr3', '.crw', '.arw', '.srf', '.sr2', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f', '.3fr', '.iiq', '.rwl', '.erf', '.mef', '.mos', '.kdc']);
export const CATALOG_MARKERS = ['.lrcat', '.lrcat-data', '.lrdata', '.lrcat-wal', '.lrcat-shm'];

function scanForUnsafe(dir: string, depth: number, maxDepth: number): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (e.isFile()) {
      const ext = path.extname(lower);
      if (RAW_EXT.has(ext)) return `RAW file "${e.name}"`;
      if (CATALOG_MARKERS.some((m) => lower.endsWith(m))) return `Lightroom catalog artefact "${e.name}"`;
    } else if (e.isDirectory()) {
      if (CATALOG_MARKERS.some((m) => lower.endsWith(m))) return `Lightroom catalog artefact "${e.name}"`;
      if (depth < maxDepth) {
        const hit = scanForUnsafe(path.join(dir, e.name), depth + 1, maxDepth);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * The agent may only watch an explicitly configured FINAL JPEG tree.
 * Refuses: relative/empty paths, home or filesystem/volume roots, anything containing RAW files or Lightroom
 * catalog artefacts within the first 3 levels. (Shallow by design: cheap, and the library is YYYY/Location/files.)
 */
export function assertSafeLibraryRoot(root: string | undefined): string {
  if (!root || !path.isAbsolute(root)) throw new UnsafeLibraryRootError('FINAL_DIR must be set to an absolute path.');
  const resolved = path.resolve(root);
  const parts = resolved.split(path.sep).filter(Boolean);
  if (resolved === path.parse(resolved).root || resolved === os.homedir() || (parts[0] === 'Volumes' && parts.length <= 2))
    throw new UnsafeLibraryRootError(`Refusing broad root: ${resolved}`);
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new UnsafeLibraryRootError(`FINAL_DIR does not exist: ${resolved}`);
  }
  if (!st.isDirectory()) throw new UnsafeLibraryRootError(`FINAL_DIR is not a directory: ${resolved}`);
  const hit = scanForUnsafe(resolved, 0, 3);
  if (hit) throw new UnsafeLibraryRootError(`Refusing ${resolved}: contains ${hit}. AI PhotoVault only watches final JPEG exports.`);
  return resolved;
}

export function isJpeg(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg';
}

/** Parses `YYYY/Location/...` folder-derived metadata (provenance FOLDER_DERIVED). */
export function folderMetadata(relPath: string): { year: number | null; location: string | null; subpath: string | null } {
  const segs = relPath.split(/[\\/]/).filter(Boolean);
  const dirs = segs.slice(0, -1);
  const year = dirs[0] && /^\d{4}$/.test(dirs[0]) ? Number(dirs[0]) : null;
  const location = year !== null ? (dirs[1] ?? null) : null;
  const subpath = year !== null && dirs.length > 2 ? dirs.slice(2).join('/') : null;
  return { year, location, subpath };
}
