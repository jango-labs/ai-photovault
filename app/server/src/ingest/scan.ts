import fs from 'node:fs/promises';
import path from 'node:path';
import { CATALOG_MARKERS, RAW_EXT } from '@photovault/shared';
import { isInside } from './approval.js';

/**
 * Read-only, confined directory walk. This module only reads directory entries and file metadata (lstat): it imports no
 * write/delete/rename/copy primitive (a test enforces that), never follows symbolic links, never leaves `root`, and never even
 * opens RAW files or Lightroom catalogue artefacts.
 */
export interface ScanEntry { relpath: string; size: number; mtimeMs: number }
export type SkipReason = 'symlink' | 'not_regular' | 'hidden' | 'raw_file' | 'catalog' | 'not_jpeg' | 'too_deep' | 'bad_name' | 'unreadable';
export interface ScanSkip { relpath: string; reason: SkipReason }
export type ScanEvent = { type: 'file'; entry: ScanEntry } | { type: 'skip'; skip: ScanSkip } | { type: 'dir'; relpath: string };

export const MAX_DEPTH = 8;
const JPEG_EXT = new Set(['.jpg', '.jpeg']);

export async function* walk(root: string, opts: { maxDepth?: number; signal?: AbortSignal } = {}): AsyncGenerator<ScanEvent> {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  async function* dir(abs: string, rel: string, depth: number): AsyncGenerator<ScanEvent> {
    if (opts.signal?.aborted) return;
    let names: string[];
    try { names = (await fs.readdir(abs)).sort(); } catch { yield { type: 'skip', skip: { relpath: rel || '.', reason: 'unreadable' } }; return; }
    yield { type: 'dir', relpath: rel };
    for (const name of names) {
      if (opts.signal?.aborted) return;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(abs, name);
      if (name.includes('\0') || name === '.' || name === '..' || !isInside(root, childAbs)) { yield { type: 'skip', skip: { relpath: childRel, reason: 'bad_name' } }; continue; }
      if (name.startsWith('.')) { yield { type: 'skip', skip: { relpath: childRel, reason: 'hidden' } }; continue; }
      let st;
      try { st = await fs.lstat(childAbs); } catch { yield { type: 'skip', skip: { relpath: childRel, reason: 'unreadable' } }; continue; }
      const lower = name.toLowerCase();
      if (st.isSymbolicLink()) { yield { type: 'skip', skip: { relpath: childRel, reason: 'symlink' } }; continue; }           // never followed
      if (CATALOG_MARKERS.some((m) => lower.endsWith(m))) { yield { type: 'skip', skip: { relpath: childRel, reason: 'catalog' } }; continue; }
      if (st.isDirectory()) {
        if (depth >= maxDepth) { yield { type: 'skip', skip: { relpath: childRel, reason: 'too_deep' } }; continue; }
        yield* dir(childAbs, childRel, depth + 1);
        continue;
      }
      if (!st.isFile()) { yield { type: 'skip', skip: { relpath: childRel, reason: 'not_regular' } }; continue; }
      const ext = path.extname(lower);
      if (RAW_EXT.has(ext)) { yield { type: 'skip', skip: { relpath: childRel, reason: 'raw_file' } }; continue; }              // never opened
      if (!JPEG_EXT.has(ext)) { yield { type: 'skip', skip: { relpath: childRel, reason: 'not_jpeg' } }; continue; }
      yield { type: 'file', entry: { relpath: childRel, size: st.size, mtimeMs: st.mtimeMs } };
    }
  }
  yield* dir(root, '', 0);
}

/** Absolute path of a scanned file, re-checked to be inside `root` (defence in depth before any read). */
export function absoluteInside(root: string, relpath: string): string {
  if (!relpath || relpath.startsWith('/') || relpath.split('/').includes('..') || relpath.includes('\0')) throw new Error(`unsafe relative path: ${relpath}`);
  const abs = path.join(root, relpath);
  if (!isInside(root, abs)) throw new Error(`path escapes the source directory: ${relpath}`);
  return abs;
}
