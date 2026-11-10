import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isInside } from './approval.js';

/**
 * Preview generation. Reads the source JPEG (read-only) and writes ONLY inside the derivatives directory, which must not be
 * inside any source directory. Previews are re-encoded without metadata (no EXIF, no GPS) and auto-oriented, and are explicitly converted to sRGB using
 * the source's embedded colour profile (Display P3, Adobe RGB, ProPhoto… all become sRGB; an untagged source is taken as sRGB). The source file itself is
 * never modified: its pixels and its profile stay exactly as exported.
 */
export const DERIVATIVE_SPEC = { version: 1, thumb: { long: 480, quality: 78 }, view: { long: 1600, quality: 82 } } as const;

export function derivativeDir(derivativesRoot: string, versionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new Error('invalid version id');
  return path.join(derivativesRoot, versionId);
}

export function assertDerivativesOutsideSources(derivativesRoot: string, sourceRoots: string[]): void {
  const d = path.resolve(derivativesRoot);
  for (const s of sourceRoots) if (isInside(path.resolve(s), d) || isInside(d, path.resolve(s))) throw new Error('the derivatives directory must be separate from the photograph source directories');
}

async function writeAtomic(dest: string, data: Buffer): Promise<void> {
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, dest);
}

export async function generateDerivatives(sourceAbs: string, derivativesRoot: string, versionId: string): Promise<{ thumbBytes: number; viewBytes: number }> {
  const dir = derivativeDir(derivativesRoot, versionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const make = (long: number, quality: number) => sharp(sourceAbs, { failOn: 'error' }).rotate().resize({ width: long, height: long, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').jpeg({ quality, mozjpeg: true, progressive: true }).toBuffer();
  const [thumb, view] = await Promise.all([make(DERIVATIVE_SPEC.thumb.long, DERIVATIVE_SPEC.thumb.quality), make(DERIVATIVE_SPEC.view.long, DERIVATIVE_SPEC.view.quality)]);
  await writeAtomic(path.join(dir, 'thumb.jpg'), thumb);
  await writeAtomic(path.join(dir, 'view.jpg'), view);
  return { thumbBytes: thumb.length, viewBytes: view.length };
}
