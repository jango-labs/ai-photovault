/**
 * Writes the bundled SYNTHETIC demo photographs (procedurally generated images with invented EXIF/IPTC/XMP metadata) into a new folder:
 *   npm run demo:photos -- --out /absolute/new/folder
 * No real photograph is read or written. Refuses a non-empty folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoPhotos, type Mood } from '../demo/dataset.js';
import { makeJpeg } from '../ingest/testkit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, '../../../web/public/fixtures');

export async function writeDemoPhotos(out: string): Promise<number> {
  if (!path.isAbsolute(out)) throw new Error('--out must be an absolute path');
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('the output folder is not empty');
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Array<{ id: string; mood: Mood }>;
  const photos = demoPhotos(manifest);
  for (const p of photos) {
    await makeJpeg(path.join(out, p.relpath), {
      base: path.join(FIXTURE_DIR, `${p.fixture}.jpg`), make: p.make, model: p.model, lens: p.lens, focal: p.focal, fnumber: p.fnumber, exposure: p.exposure, iso: p.iso,
      captureAt: p.captureAt, ...(p.gps ? { gps: p.gps } : {}), copyright: 'Demo image, CC0 (public domain dedication)',
      iptc: { title: p.title, caption: p.description, keywords: p.keywords, city: p.place.name, country: p.place.country, countryCode: p.place.cc },
      xmp: { rating: p.rating, title: p.title, description: p.description, subject: p.keywords },
    });
  }
  return photos.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out'); const out = i >= 0 ? process.argv[i + 1] : undefined;
  if (!out) { console.error('usage: demo:photos --out /absolute/new/folder'); process.exit(2); }
  writeDemoPhotos(out).then((n) => console.log(`wrote ${n} synthetic demo photographs to ${out}`), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
