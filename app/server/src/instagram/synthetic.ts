import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Manifest } from './provider.js';

/**
 * A synthetic Instagram archive built FROM the user's own library pictures, for development and tests (never for production data):
 * most posts are faithful re-exports, some are cropped to 4:5, some are colour-edited, some are unrelated pictures. It writes a manifest
 * and image files into the archive folder; nothing is sent anywhere and no Instagram account is involved.
 */
export interface LibrarySource { photoId: string; title: string | null; place: string | null; captureAt: Date | null; file: string }
export interface ArchiveSummary { posts: number; faithful: number; cropped: number; edited: number; unrelated: number }
export type Kind = 'faithful' | 'cropped' | 'edited' | 'unrelated';
/** deterministic mix: 60 % faithful, 20 % cropped, 10 % edited, 10 % unrelated */
export const kindOf = (i: number): Kind => { const r = i % 10; return r < 6 ? 'faithful' : r < 8 ? 'cropped' : r === 8 ? 'edited' : 'unrelated'; };

async function unrelated(i: number): Promise<Buffer> {
  const h = (n: number) => (Math.imul(i + 1, 2654435761) ^ Math.imul(n + 7, 40503)) >>> 0;
  const c = (n: number) => `rgb(${h(n) % 200 + 30},${h(n + 1) % 200 + 30},${h(n + 2) % 200 + 30})`;
  const shapes = Array.from({ length: 9 }, (_, k) => `<rect x="${h(k * 3) % 900}" y="${h(k * 3 + 1) % 1100}" width="${150 + h(k * 3 + 2) % 400}" height="${120 + h(k + 50) % 500}" fill="${c(k * 5)}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="${c(99)}"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 78 }).toBuffer();
}

async function render(file: string, kind: Kind, i: number): Promise<Buffer> {
  if (kind === 'unrelated') return unrelated(i);
  const base = sharp(file).rotate();
  if (kind === 'faithful') return base.resize({ width: 1080, height: 1350, fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
  const meta = await sharp(file).rotate().metadata(); const w = meta.width ?? 1000, h = meta.height ?? 1000;
  if (kind === 'cropped') {
    const targetW = Math.min(w, Math.round(h * 0.8)); const left = Math.floor((w - targetW) / 2);                 // centre 4:5 crop
    return sharp(file).rotate().extract({ left, top: 0, width: targetW, height: h }).resize({ width: 1080, height: 1350, fit: 'cover' }).jpeg({ quality: 72 }).toBuffer();
  }
  return base.modulate({ brightness: 1.18, saturation: 1.35 }).sharpen().resize({ width: 1080, height: 1350, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
}

export async function writeSyntheticArchive(dir: string, sources: LibrarySource[], o: { now?: Date } = {}): Promise<ArchiveSummary> {
  const now = o.now ?? new Date();
  await fs.rm(path.join(dir, 'img'), { recursive: true, force: true }); await fs.mkdir(path.join(dir, 'img'), { recursive: true, mode: 0o700 });
  const posts: Manifest['posts'] = []; const sum: ArchiveSummary = { posts: 0, faithful: 0, cropped: 0, edited: 0, unrelated: 0 };
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!; const kind = kindOf(i);
    const bytes = await render(s.file, kind, i); const rel = `img/${i}.jpg`; await fs.writeFile(path.join(dir, rel), bytes, { mode: 0o600 });
    const meta = await sharp(bytes).metadata();
    const base = s.captureAt ?? new Date(now.getTime() - 400 * 86_400_000);
    const postedAt = new Date(Math.min(now.getTime() - 86_400_000, base.getTime() + (7 + ((i * 37) % 300)) * 86_400_000));
    posts.push({
      id: `syn-${i}`, permalink: null, mediaType: 'IMAGE', postedAt: postedAt.toISOString(),
      caption: `${s.title ?? s.place ?? 'A photograph'} — synthetic caption ${i + 1} #wildlife #synthetic`,
      media: [{ id: `syn-m-${i}`, file: rel, ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}) }],
    });
    sum.posts++; sum[kind]++;
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ posts }, null, 1), { mode: 0o600 });
  return sum;
}
