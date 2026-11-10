import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { makeJpeg } from '../ingest/testkit.js';
import { AspectError, MAX_BYTES, PresignedUrlDelivery, prepareDeliveryImage, type Signer } from './delivery.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-del-')); afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = async (name: string, o: Parameters<typeof makeJpeg>[1]) => { const f = path.join(dir, name); await makeJpeg(f, o); return f; };

describe('the copy that leaves the machine for Instagram', () => {
  it('strips every piece of metadata (EXIF, GPS, camera serial, IPTC) and never touches the source', async () => {
    const f = await file('rich.jpg', { width: 3000, height: 2400, make: 'Canon', model: 'EOS R5', serial: 'SN-1234', gps: { lat: -1.29, lon: 36.82 }, copyright: 'Me', artist: 'Me', iptc: { title: 'private title', keywords: ['k1'], caption: 'secret' }, captureAt: '2024:06:14 17:00:00' });
    const before = fs.readFileSync(f); expect((await sharp(f).metadata()).exif).toBeTruthy();
    const { jpeg } = await prepareDeliveryImage(f); const m = await sharp(jpeg).metadata();
    expect(m.exif).toBeUndefined(); expect(m.iptc).toBeUndefined(); expect(m.xmp).toBeUndefined(); expect(m.icc ?? Buffer.alloc(0)).toBeTruthy();
    for (const needle of ['SN-1234', 'Canon', 'secret', 'private title', 'GPS', 'Exif']) expect(jpeg.includes(Buffer.from(needle)), needle).toBe(false);
    expect(fs.readFileSync(f).equals(before)).toBe(true);
  });
  it('is a JPEG of at most 1440 px on the long edge, never enlarged, in sRGB', async () => {
    const big = await prepareDeliveryImage(await file('big.jpg', { width: 6000, height: 4800 })); expect(big).toMatchObject({ width: 1440, height: 1152 }); expect((await sharp(big.jpeg).metadata()).format).toBe('jpeg');
    const small = await prepareDeliveryImage(await file('small.jpg', { width: 800, height: 640 })); expect(small).toMatchObject({ width: 800, height: 640 }); expect((await sharp(small.jpeg).metadata()).space).toBe('srgb');
    expect(big.jpeg.length).toBeLessThanOrEqual(MAX_BYTES);
  });
  it('accepts Instagram’s ratios (4:5 to 1.91:1) at the edges and refuses anything outside — it never crops for you', async () => {
    for (const [w, h] of [[800, 1000], [1910, 1000], [1000, 1000], [1500, 1000]] as const) await expect(prepareDeliveryImage(await file(`ok-${w}x${h}.jpg`, { width: w, height: h }))).resolves.toBeTruthy();
    for (const [w, h] of [[1000, 1300], [2100, 1000], [500, 2000]] as const) { const e = await prepareDeliveryImage(await file(`bad-${w}x${h}.jpg`, { width: w, height: h })).catch((x) => x); expect(e, `${w}x${h}`).toBeInstanceOf(AspectError); expect((e as Error).message).toMatch(/Choose a crop first/); }
  });
  it('honours the EXIF orientation when judging the ratio (a rotated landscape is a portrait)', async () => {
    const r = await prepareDeliveryImage(await file('rot.jpg', { width: 1600, height: 1280, orientation: 6 })); expect(r.width).toBeLessThan(r.height);
  });
  it('rejects things that are not images', async () => {
    const f = path.join(dir, 'x.jpg'); fs.writeFileSync(f, 'not an image'); await expect(prepareDeliveryImage(f)).rejects.toBeTruthy();
  });
});

describe('the object-storage design (tested with a fake; never constructed by the app)', () => {
  const fake = () => { const objects = new Map<string, Buffer>(); const calls: string[] = []; const s: Signer = { async put(k, b) { objects.set(k, b); calls.push(`put ${k}`); }, async presignGet(k, ttl) { calls.push(`sign ${ttl}`); return `https://bucket.example.invalid/${k}?sig=x&ttl=${ttl}`; }, async remove(k) { objects.delete(k); calls.push(`remove ${k}`); } }; return { s, objects, calls }; };
  it('uploads under an unguessable key (no user, photograph or post id in it), signs a URL of at most 15 minutes, and revoking deletes the object', async () => {
    const f = fake(); const d = new PresignedUrlDelivery(f.s); const out = await d.prepare({ jpeg: Buffer.from('jpeg') });
    const key = [...f.objects.keys()][0]!; expect(key).toMatch(/^delivery\/[A-Za-z0-9_-]{32}\.jpg$/); expect(out.url).toContain(key); expect(out.url).toContain('ttl=900'); expect(out.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(900_000);
    await out.revoke(); expect(f.objects.size).toBe(0);
    const a = await d.prepare({ jpeg: Buffer.from('1') }), b = await d.prepare({ jpeg: Buffer.from('2') }); expect(new Set(f.objects.keys()).size).toBe(2); void a; void b;
  });
  it('refuses a longer lifetime', () => { expect(() => new PresignedUrlDelivery(fake().s, 901)).toThrow(/15 minutes/); expect(() => new PresignedUrlDelivery(fake().s, 600)).not.toThrow(); });
});
