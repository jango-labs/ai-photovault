import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDerivatives } from './derive.js';
import { readMeta } from './extract.js';
import { absoluteInside, walk, type ScanEvent } from './scan.js';
import { makeJpeg } from './testkit.js';

/** Hostile and broken input: a file from outside must never crash the importer, escape the source folder, or be written to. */
let dir: string; let out: string;
beforeAll(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-hostile-'))); out = path.join(dir, 'derived'); fs.mkdirSync(out); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (name: string, data: Buffer) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };

describe('damaged images are refused cleanly and leave nothing behind', () => {
  it('zero-byte, text-as-jpg, truncated and garbage-after-header files all throw a plain error', async () => {
    await makeJpeg(path.join(dir, 'good.jpg'), { width: 400, height: 300 });
    const good = fs.readFileSync(path.join(dir, 'good.jpg'));
    const cases: Array<[string, Buffer]> = [['empty.jpg', Buffer.alloc(0)], ['text.jpg', Buffer.from('<?php system($_GET["c"]); ?>')], ['truncated.jpg', good.subarray(0, Math.floor(good.length / 3))],
      ['garbage.jpg', Buffer.concat([good.subarray(0, 200), Buffer.alloc(5000, 0xaa)])], ['header-only.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])]];
    for (const [name, data] of cases) {
      const f = put(name, data);
      const id = randomUUID();
      await expect(generateDerivatives(f, out, id), `${name} derive`).rejects.toThrow(/^(?!invalid version id)/);
      expect(fs.existsSync(path.join(out, id, 'thumb.jpg')), `${name} left a thumbnail`).toBe(false);
      if (!/truncated|garbage/.test(name)) await expect(readMeta(f), `${name} meta`).rejects.toThrow();   // an intact header can be read; the pixels are what fail (and derive refuses them)
    }
      });
  it('a decompression bomb (huge dimensions, tiny file) is refused by the pixel limit instead of exhausting memory', async () => {
    const bomb = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg({ quality: 1 }).toBuffer();
    const sof = bomb.findIndex((v, i) => v === 0xff && (bomb[i + 1] === 0xc0 || bomb[i + 1] === 0xc2));          // the frame header claims 30000 × 30000 (900 megapixels)
    bomb.writeUInt16BE(30_000, sof + 5); bomb.writeUInt16BE(30_000, sof + 7);
    const f = put('bomb.jpg', bomb);
    await expect(generateDerivatives(f, out, randomUUID())).rejects.toThrow(/pixel|exceed|limit/i);
  });
  it('the originals are never modified by reading or deriving', async () => {
    const f = path.join(dir, 'good.jpg'); const before = fs.readFileSync(f); const st = fs.statSync(f);
    await readMeta(f); await generateDerivatives(f, out, randomUUID());
    expect(fs.readFileSync(f).equals(before)).toBe(true); expect(fs.statSync(f).mtimeMs).toBe(st.mtimeMs);
  });
});

describe('malicious metadata is carried as inert text', () => {
  it('markup and control characters in IPTC/XMP text survive as plain strings (the UI renders text, never HTML) and do not break parsing', async () => {
    const f = path.join(dir, 'xss.jpg'); const evil = '<img src=x onerror=alert(1)>"\'<script>alert(2)</script>';
    await makeJpeg(f, { iptc: { title: evil, caption: evil, keywords: [evil, 'ok'], city: evil, byline: evil }, xmp: { title: evil, description: evil, creator: evil, subject: [evil] } });
    const m = await readMeta(f);
    const text = JSON.stringify(m);
    expect(text).toContain('onerror'); expect(typeof m.width).toBe('number');           // stored verbatim as data …
    expect(Object.keys(m).every((k) => !/html/i.test(k))).toBe(true);                    // … never as a rendered field
  });
  it('an XML entity-expansion packet in XMP cannot blow up the reader', async () => {
    const f = path.join(dir, 'xxe.jpg'); await makeJpeg(f, {});
    const jpg = fs.readFileSync(f);
    const xml = `<?xpacket begin="x" id="W5M0MpCehiHzreSzNTczkc9d"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d SYSTEM "file:///etc/passwd">]><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&c;&d;</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const head = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'); const data = Buffer.from(xml); const len = 2 + head.length + data.length;
    const seg = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 255]), head, data]);
    const hostile = put('xxe2.jpg', Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]));
    const t0 = Date.now(); const m = await readMeta(hostile).catch(() => null);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(JSON.stringify(m ?? {})).not.toContain('root:');                              // /etc/passwd is never read through an entity
  });
});

describe('paths and links cannot leave the source folder', () => {
  it('relative paths with .., absolute paths and NUL bytes are refused', () => {
    for (const bad of ['../x.jpg', 'a/../../x.jpg', '/etc/passwd', 'a\0b.jpg', '']) expect(() => absoluteInside(dir, bad), bad).toThrow();
    expect(absoluteInside(dir, 'a/b.jpg')).toBe(path.join(dir, 'a/b.jpg'));
  });
  it('a symlink to a file or folder outside the source is skipped, not followed', async () => {
    const src = path.join(dir, 'src'); fs.mkdirSync(src); const secret = path.join(dir, 'secret'); fs.mkdirSync(secret);
    await makeJpeg(path.join(secret, 'private.jpg'), {}); await makeJpeg(path.join(src, 'real.jpg'), {});
    fs.symlinkSync(path.join(secret, 'private.jpg'), path.join(src, 'link.jpg')); fs.symlinkSync(secret, path.join(src, 'linkdir'));
    const files: string[] = []; const skips: string[] = [];
    for await (const e of walk(src) as AsyncGenerator<ScanEvent>) { if (e.type === 'file') files.push(e.entry.relpath); if (e.type === 'skip') skips.push(`${e.skip.relpath}:${e.skip.reason}`); }
    expect(files).toEqual(['real.jpg']); expect(skips.length).toBe(2); expect(skips.every((s) => s.endsWith(':symlink'))).toBe(true);
  });
});
