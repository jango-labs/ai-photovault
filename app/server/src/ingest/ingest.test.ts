import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { NotApprovedError, assertApproved, canonical, isInside, loadPolicy, approvalPath } from './approval.js';
import { assertDerivativesOutsideSources, derivativeDir, generateDerivatives } from './derive.js';
import { parseExifDate, readMeta, sha256File } from './extract.js';
import { fingerprint, hamming } from './hash.js';
import { absoluteInside, walk, type ScanEvent } from './scan.js';
import { makeJpeg } from './testkit.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ingest-'))); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const collect = async (root: string, o = {}) => { const files: string[] = [], skips: Array<[string, string]> = []; for await (const e of walk(root, o) as AsyncIterable<ScanEvent>) { if (e.type === 'file') files.push(e.entry.relpath); else if (e.type === 'skip') skips.push([e.skip.relpath, e.skip.reason]); } return { files, skips }; };

describe('approval: nothing is scanned unless the owner approved that exact directory', () => {
  it('by default nothing is approved, whatever the path — including the owner’s own export folder', () => {
    const state = tmp(); const policy = loadPolicy(state);
    expect(policy.approved).toEqual([]);
    for (const p of [os.tmpdir(), path.join(os.homedir(), 'Desktop', 'MyPhotos'), '/', os.homedir()]) for (const m of ['DRY_RUN', 'APPLY'] as const) expect(() => assertApproved(policy, p, m), `${p} ${m}`).toThrow(NotApprovedError);
  });
  it('a malformed or tampered approvals file approves nothing', () => {
    const state = tmp(); fs.mkdirSync(path.join(state, 'approvals')); const f = approvalPath(state);
    for (const body of ['not json', '{"roots":"x"}', '{"roots":[{"path":"/a","modes":["DELETE"],"approvedAt":"x"}]}', '{"roots":[],"extra":1}']) { fs.writeFileSync(f, body); expect(loadPolicy(state).approved).toEqual([]); }
  });
  it('approval is per directory and per mode; sub-directories, parents and look-alikes are not approved', () => {
    const state = tmp(); const src = tmp(); fs.mkdirSync(path.join(src, 'sub')); fs.mkdirSync(path.join(state, 'approvals'));
    fs.writeFileSync(approvalPath(state), JSON.stringify({ roots: [{ path: src, modes: ['DRY_RUN'], approvedAt: new Date().toISOString() }] }));
    const policy = loadPolicy(state);
    expect(assertApproved(policy, src, 'DRY_RUN')).toBe(canonical(src));
    expect(() => assertApproved(policy, src, 'APPLY')).toThrow(NotApprovedError);
    expect(() => assertApproved(policy, path.join(src, 'sub'), 'DRY_RUN')).toThrow(NotApprovedError);
    expect(() => assertApproved(policy, path.dirname(src), 'DRY_RUN')).toThrow(NotApprovedError);
    expect(() => assertApproved(policy, src + '-other', 'DRY_RUN')).toThrow(NotApprovedError);
  });
  it('a symbolic link to an approved directory is the same directory; a link to an unapproved one is not', () => {
    const src = tmp(), other = tmp(), links = tmp();
    fs.symlinkSync(src, path.join(links, 'to-src')); fs.symlinkSync(other, path.join(links, 'to-other'));
    const policy = { approved: [{ path: src, modes: ['APPLY' as const], approvedAt: 'x' }] };
    expect(assertApproved(policy, path.join(links, 'to-src'), 'APPLY')).toBe(canonical(src));
    expect(() => assertApproved(policy, path.join(links, 'to-other'), 'APPLY')).toThrow(NotApprovedError);
  });
  it('isInside is a real containment test', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true); expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false); expect(isInside('/a/b', '/a/b/../c')).toBe(false); expect(isInside('/a/b', '/')).toBe(false);
  });
});

describe('the scanner is confined and read-only', () => {
  it('finds JPEGs recursively in a stable order and skips everything else without opening it', async () => {
    const root = tmp();
    for (const f of ['2024/Kenya/a.jpg', '2024/Kenya/B.JPEG', '2024/Norway/c.jpg', '2023/d.jpg']) await makeJpeg(path.join(root, f), { width: 64, height: 48 });
    for (const f of ['2024/Kenya/raw1.NEF', '2024/Kenya/raw2.CR3', '2024/Kenya/notes.txt', '2024/Kenya/x.png', '.DS_Store']) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x'); }
    fs.mkdirSync(path.join(root, 'Catalog.lrdata')); fs.writeFileSync(path.join(root, 'Catalog.lrdata', 'inside.jpg'), 'x'); fs.writeFileSync(path.join(root, 'main.lrcat'), 'x');
    const { files, skips } = await collect(root);
    expect(files).toEqual(['2023/d.jpg', '2024/Kenya/B.JPEG', '2024/Kenya/a.jpg', '2024/Norway/c.jpg']);
    const reason = (p: string) => skips.find(([r]) => r === p)?.[1];
    expect(reason('2024/Kenya/raw1.NEF')).toBe('raw_file'); expect(reason('2024/Kenya/raw2.CR3')).toBe('raw_file'); expect(reason('main.lrcat')).toBe('catalog'); expect(reason('Catalog.lrdata')).toBe('catalog');
    expect(reason('.DS_Store')).toBe('hidden'); expect(reason('2024/Kenya/x.png')).toBe('not_jpeg'); expect(files.some((f) => f.includes('Catalog.lrdata'))).toBe(false);
  });
  it('never follows symbolic links (file or directory) out of the source', async () => {
    const root = tmp(), outside = tmp();
    await makeJpeg(path.join(outside, 'secret.jpg'), { width: 64, height: 48 }); await makeJpeg(path.join(root, 'ok.jpg'), { width: 64, height: 48 });
    fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(root, 'link.jpg')); fs.symlinkSync(outside, path.join(root, 'linkdir')); fs.symlinkSync('/', path.join(root, 'rootlink'));
    const { files, skips } = await collect(root);
    expect(files).toEqual(['ok.jpg']);
    expect(skips.filter(([, r]) => r === 'symlink').map(([p]) => p).sort()).toEqual(['link.jpg', 'linkdir', 'rootlink']);
  });
  it('bounds its depth and honours an abort signal', async () => {
    const root = tmp(); let d = root; for (let i = 0; i < 12; i++) { d = path.join(d, `l${i}`); fs.mkdirSync(d); }
    await makeJpeg(path.join(d, 'deep.jpg'), { width: 32, height: 32 }); await makeJpeg(path.join(root, 'top.jpg'), { width: 32, height: 32 });
    const r = await collect(root, { maxDepth: 8 }); expect(r.files).toEqual(['top.jpg']); expect(r.skips.some(([, why]) => why === 'too_deep')).toBe(true);
    const ac = new AbortController(); ac.abort(); expect((await collect(root, { signal: ac.signal })).files).toEqual([]);
  });
  it('absoluteInside refuses anything that could leave the directory', () => {
    const root = '/srv/photos';
    expect(absoluteInside(root, '2024/Kenya/a.jpg')).toBe('/srv/photos/2024/Kenya/a.jpg');
    for (const bad of ['../x.jpg', 'a/../../x.jpg', '/etc/passwd', '', 'a\0b.jpg']) expect(() => absoluteInside(root, bad), bad).toThrow();
  });
  it('the reading modules contain no way to modify, move or delete a file (static check)', () => {
    const names = 'writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rename|renameSync|copyFile|copyFileSync|truncate|chmod|chown|symlink|createWriteStream|utimes|mkdir|mkdirSync|cp|cpSync';
    const forbidden = new RegExp(`(\\.(${names})\\s*\\()|(import\\s*\\{[^}]*\\b(${names})\\b[^}]*\\}\\s*from\\s*'node:fs)`);
    for (const f of ['scan.ts', 'extract.ts', 'hash.ts', 'approval.ts']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
      expect(src, f).not.toMatch(forbidden);
    }
  });
  it('the originals are byte-for-byte and mtime-for-mtime unchanged after scanning, reading metadata, hashing and deriving', async () => {
    const root = tmp(), out = tmp();
    await makeJpeg(path.join(root, '2024/Kenya/a.jpg'), { width: 1200, height: 800, make: 'Canon', captureAt: '2024:03:12 06:30:00', gps: { lat: -1.4, lon: 35.1 } });
    const f = path.join(root, '2024/Kenya/a.jpg'); const before = { bytes: fs.readFileSync(f), mtime: fs.statSync(f).mtimeMs, dir: fs.readdirSync(path.dirname(f)) };
    await collect(root); await readMeta(f); await sha256File(f); await fingerprint(f); await generateDerivatives(f, out, '11111111-1111-4111-8111-111111111111');
    expect(fs.readFileSync(f).equals(before.bytes)).toBe(true); expect(fs.statSync(f).mtimeMs).toBe(before.mtime); expect(fs.readdirSync(path.dirname(f))).toEqual(before.dir);
  });
});

describe('metadata extraction', () => {
  it('reads EXIF, GPS, IPTC and dimensions; the capture time is kept exactly as written', async () => {
    const root = tmp(); const f = path.join(root, 'a.jpg');
    await makeJpeg(f, { width: 640, height: 427, make: 'Canon', model: 'Canon EOS R5', lens: 'RF100-500mm F4.5-7.1 L IS USM', focal: 500, fnumber: 7.1, exposure: '1/2000', iso: 800, captureAt: '2024:03:12 06:30:00', subsec: '25', gps: { lat: -1.4, lon: 35.1 }, copyright: '(c) Test', artist: 'Tester', iptc: { keywords: ['lion', 'savanna'], title: 'Lion at dawn', caption: 'A lion walks.' } });
    const m = await readMeta(f);
    expect(m).toMatchObject({ width: 640, height: 427, cameraMake: 'Canon', cameraModel: 'Canon EOS R5', lens: 'RF100-500mm F4.5-7.1 L IS USM', focalLengthMm: 500, aperture: 7.1, iso: 800, copyright: '(c) Test', photographer: 'Tester', title: 'Lion at dawn', description: 'A lion walks.' });
    expect(m.shutterSeconds).toBeCloseTo(0.0005, 6); expect(m.keywords).toEqual(['lion', 'savanna']);
    expect(m.captureAt!.toISOString().slice(0, 19)).toBe('2024-03-12T06:30:00'); expect(m.gps!.lat).toBeCloseTo(-1.4, 3); expect(m.gps!.lon).toBeCloseTo(35.1, 3);
    expect(m.identityKey).toContain('2024:03:12 06:30:00'); expect(Object.keys(m.exif)).toContain('Make');
    const burst = path.join(root, 'burst.jpg'); await makeJpeg(burst, { width: 100, height: 80, captureAt: '2024:03:12 06:30:00' });
    expect((await readMeta(burst)).identityKey).toBeNull();                                          // whole-second time only: a burst shares it, so it is not an identity
  });
  it('a photograph with no metadata yields nothing invented', async () => {
    const f = path.join(tmp(), 'plain.jpg'); await makeJpeg(f, { width: 100, height: 80 });
    const m = await readMeta(f);
    expect(m).toMatchObject({ cameraMake: null, cameraModel: null, lens: null, captureAt: null, gps: null, iso: null, title: null, identityKey: null, keywords: [] });
  });
  it('a sideways-stored image reports its displayed size', async () => {
    const f = path.join(tmp(), 'rot.jpg'); await makeJpeg(f, { width: 800, height: 400, orientation: 6 });
    const m = await readMeta(f); expect([m.width, m.height]).toEqual([400, 800]);
  });
  it('rejects a file that is not a JPEG instead of guessing', async () => {
    const f = path.join(tmp(), 'bad.jpg'); fs.writeFileSync(f, 'this is not an image');
    await expect(readMeta(f)).rejects.toThrow();
  });
  it('parseExifDate: valid, sub-seconds, impossible and malformed values', () => {
    expect(parseExifDate('2024:03:12 06:30:00')!.toISOString()).toBe('2024-03-12T06:30:00.000Z');
    expect(parseExifDate('2024:03:12 06:30:00', '25')!.toISOString()).toBe('2024-03-12T06:30:00.250Z');
    for (const bad of ['0000:00:00 00:00:00', '2024:13:01 00:00:00', '2024:02:30 25:00:00', 'yesterday', '', 5, null, undefined]) expect(parseExifDate(bad as never), String(bad)).toBeNull();
  });
  it('sha256File matches the reference implementation', async () => {
    const f = path.join(tmp(), 'a.jpg'); await makeJpeg(f, { width: 200, height: 100 });
    expect((await sha256File(f)).toString('hex')).toBe(createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  });
});

describe('perceptual fingerprints', () => {
  it('survive resizing and recompression, and tell different pictures apart', async () => {
    const d = tmp();
    await makeJpeg(path.join(d, 'a.jpg'), { width: 1200, height: 800, pattern: 3, color: { r: 40, g: 90, b: 140 } });
    await sharp(path.join(d, 'a.jpg')).resize(600, 400).jpeg({ quality: 55 }).toFile(path.join(d, 'a-small.jpg'));
    await sharp(path.join(d, 'a.jpg')).resize(900, 600).jpeg({ quality: 90 }).toFile(path.join(d, 'a-med.jpg'));
    await makeJpeg(path.join(d, 'b.jpg'), { width: 1200, height: 800, pattern: 41, color: { r: 200, g: 60, b: 30 } });
    const [a, small, med, b] = await Promise.all(['a.jpg', 'a-small.jpg', 'a-med.jpg', 'b.jpg'].map((f) => fingerprint(path.join(d, f))));
    expect(hamming(a!.phash, small!.phash)).toBeLessThanOrEqual(10);                 // half size at JPEG quality 55
    expect(hamming(a!.phash, med!.phash)).toBeLessThanOrEqual(6);
    expect(hamming(a!.phash, b!.phash)).toBeGreaterThan(12);
    expect(a!.phash >= -(2n ** 63n) && a!.phash < 2n ** 63n).toBe(true); expect(a!.dominant).toMatch(/^#[0-9a-f]{6}$/);
    expect((await fingerprint(path.join(d, 'a.jpg'))).phash).toBe(a!.phash);                         // deterministic
  });
});

describe('preview generation', () => {
  it('writes oriented thumb (≤480) and view (≤1600) JPEGs with NO metadata, only inside the derivatives directory', async () => {
    const src = tmp(), out = tmp(); const f = path.join(src, 'big.jpg');
    await makeJpeg(f, { width: 3000, height: 2000, make: 'Canon', captureAt: '2024:03:12 06:30:00', gps: { lat: -1.4, lon: 35.1 }, copyright: 'x' });
    const id = '22222222-2222-4222-8222-222222222222';
    const r = await generateDerivatives(f, out, id);
    const [t, v] = await Promise.all([sharp(path.join(out, id, 'thumb.jpg')).metadata(), sharp(path.join(out, id, 'view.jpg')).metadata()]);
    expect([t.width, t.height]).toEqual([480, 320]); expect([v.width, v.height]).toEqual([1600, 1067]); expect(r.thumbBytes).toBeLessThan(r.viewBytes);
    for (const n of ['thumb.jpg', 'view.jpg']) { const e = await exifr.parse(path.join(out, id, n), { gps: true, tiff: true, exif: true }).catch(() => null); expect(e?.latitude ?? null).toBeNull(); expect(e?.Make ?? null).toBeNull(); }
    expect(fs.readdirSync(path.join(out, id)).sort()).toEqual(['thumb.jpg', 'view.jpg']);              // no temporary files left
    expect(fs.readdirSync(src)).toEqual(['big.jpg']);
    const small = path.join(src, 'small.jpg'); await makeJpeg(small, { width: 300, height: 200 });
    await generateDerivatives(small, out, '33333333-3333-4333-8333-333333333333');
    expect((await sharp(path.join(out, '33333333-3333-4333-8333-333333333333', 'view.jpg')).metadata()).width).toBe(300);   // never enlarged
  });
  it('a portrait stored sideways is written upright', async () => {
    const src = tmp(), out = tmp(); const f = path.join(src, 'p.jpg'); await makeJpeg(f, { width: 800, height: 400, orientation: 6 });
    await generateDerivatives(f, out, '44444444-4444-4444-8444-444444444444');
    const m = await sharp(path.join(out, '44444444-4444-4444-8444-444444444444', 'view.jpg')).metadata(); expect(m.height!).toBeGreaterThan(m.width!);
  });
  it('refuses to write previews inside (or around) a source directory, and unsafe version ids', () => {
    const src = tmp();
    expect(() => assertDerivativesOutsideSources(path.join(src, 'previews'), [src])).toThrow(); expect(() => assertDerivativesOutsideSources(path.dirname(src), [src])).toThrow();
    expect(() => assertDerivativesOutsideSources(tmp(), [src])).not.toThrow();
    for (const bad of ['../x', 'a/b', '', 'not-a-uuid']) expect(() => derivativeDir('/d', bad)).toThrow();
  });
});
