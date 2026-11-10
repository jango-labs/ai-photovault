import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { generateDerivatives } from './derive.js';

const ADOBE = '/System/Library/ColorSync/Profiles/AdobeRGB1998.icc';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-colour-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const centre = async (input: string | Buffer) => { const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true }); const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels; return [data[i]!, data[i + 1]!, data[i + 2]!]; };
const near = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

// The colour the photographer saw (in sRGB), exported into a wide-gamut profile as an editor's export would; the preview must show that colour again.
const SAMPLES = [{ r: 200, g: 40, b: 40 }, { r: 30, g: 150, b: 80 }, { r: 60, g: 90, b: 200 }];
describe('previews are explicitly converted to sRGB; the original is never touched', () => {
  const profiles: Array<[string, string, boolean]> = [['Display P3', 'p3', true], ['Adobe RGB (1998)', ADOBE, fs.existsSync(ADOBE)], ['sRGB', 'srgb', true]];
  for (const [label, profile, available] of profiles) {
    it.skipIf(!available)(`${label}: the preview carries the same colours as the sRGB original, untagged, with no metadata`, async () => {
      for (const c of SAMPLES) {
        const root = tmp(); const src = path.join(root, 'src.jpg'); const out = path.join(root, 'previews');
        await sharp({ create: { width: 640, height: 480, channels: 3, background: c } }).withIccProfile(profile).jpeg({ quality: 97 }).toFile(src);
        const before = sha(src); const stat = fs.statSync(src);
        const tagged = await sharp(src).metadata(); expect(!!tagged.icc).toBe(true);                   // the source really is tagged
        const id = '11111111-2222-3333-4444-555555555555';
        await generateDerivatives(src, out, id);
        for (const size of ['thumb', 'view']) {
          const f = path.join(out, id, `${size}.jpg`); const m = await sharp(f).metadata();
          expect(near(await centre(f), [c.r, c.g, c.b]), `${label} ${size} ${JSON.stringify(c)}`).toBe(true);
          expect(m.space).toBe('srgb'); expect(!!m.icc).toBe(false); expect(m.exif).toBeUndefined(); expect(m.xmp).toBeUndefined();
        }
        expect(sha(src)).toBe(before); expect(fs.statSync(src).mtimeMs).toBe(stat.mtimeMs);          // pixels, profile and bytes untouched
      }
    });
  }
  it('an untagged JPEG is taken as sRGB (colours unchanged)', async () => {
    const root = tmp(); const src = path.join(root, 'u.jpg'); await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 200, b: 120 } } }).jpeg({ quality: 97 }).toFile(src);
    await generateDerivatives(src, path.join(root, 'p'), '11111111-2222-3333-4444-555555555555');
    expect(near(await centre(path.join(root, 'p', '11111111-2222-3333-4444-555555555555', 'view.jpg')), [10, 200, 120])).toBe(true);
  });
});
