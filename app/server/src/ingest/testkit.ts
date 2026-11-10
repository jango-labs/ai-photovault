import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Builders for SYNTHETIC test JPEGs (never real photographs): a coloured image with optional EXIF and IPTC.
 * Used by the ingestion tests and the demo generator; the output goes to a directory the caller provides.
 */
export interface FakeJpeg {
  width?: number; height?: number; color?: { r: number; g: number; b: number }; pattern?: number;
  make?: string; model?: string; lens?: string; focal?: number; fnumber?: number; exposure?: string; iso?: number;
  captureAt?: string; subsec?: string; serial?: string; gps?: { lat: number; lon: number; alt?: number }; copyright?: string; artist?: string; orientation?: number;
  /** EXIF OffsetTimeOriginal, e.g. "-07:00" */
  offset?: string;
  iptc?: { keywords?: string[]; title?: string; caption?: string; city?: string; sublocation?: string; state?: string; country?: string; countryCode?: string; byline?: string; copyright?: string };
  /** Lightroom-style XMP packet */
  xmp?: { subject?: string[]; hierarchical?: string[]; rating?: number; label?: string; title?: string; description?: string; creator?: string; rights?: string; sublocation?: string; city?: string; state?: string; country?: string; countryCode?: string; dateCreated?: string };
  /** tag the pixels with a colour profile (pixels are converted from sRGB into it, as an editor's export would) */
  profile?: 'p3' | 'adobergb';
  /** use this existing image file's pixels instead of the generated pattern (demo images) */
  base?: string;
}

const dms = (v: number) => { const a = Math.abs(v); const d = Math.floor(a); const m = Math.floor((a - d) * 60); const s = Math.round(((a - d) * 60 - m) * 60 * 100); return `${d}/1 ${m}/1 ${s}/100`; };

function iptcSegment(i: NonNullable<FakeJpeg['iptc']>): Buffer {
  const rec = (ds: number, text: string) => { const b = Buffer.from(text, 'utf8'); return Buffer.concat([Buffer.from([0x1c, 2, ds, b.length >> 8, b.length & 255]), b]); };
  const parts = [rec(5, i.title ?? ''), ...(i.byline ? [rec(80, i.byline)] : []), ...(i.keywords ?? []).map((k) => rec(25, k)), ...(i.city ? [rec(90, i.city)] : []), ...(i.sublocation ? [rec(92, i.sublocation)] : []),
    ...(i.state ? [rec(95, i.state)] : []), ...(i.countryCode ? [rec(100, i.countryCode)] : []), ...(i.country ? [rec(101, i.country)] : []), ...(i.copyright ? [rec(116, i.copyright)] : []), ...(i.caption ? [rec(120, i.caption)] : [])].filter((b) => b.length > 5);
  const data = Buffer.concat(parts);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const res = Buffer.concat([Buffer.from('8BIM'), Buffer.from([0x04, 0x04]), Buffer.from([0, 0]), Buffer.from([data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data, pad]);
  const head = Buffer.from('Photoshop 3.0\0', 'latin1');
  const len = 2 + head.length + res.length;
  return Buffer.concat([Buffer.from([0xff, 0xed, len >> 8, len & 255]), head, res]);
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bag = (tag: string, items: string[]) => `<${tag}><rdf:Bag>${items.map((x) => `<rdf:li>${esc(x)}</rdf:li>`).join('')}</rdf:Bag></${tag}>`;
const alt = (tag: string, t: string) => `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${esc(t)}</rdf:li></rdf:Alt></${tag}>`;
function xmpSegment(x: NonNullable<FakeJpeg['xmp']>): Buffer {
  const body = [
    x.title ? alt('dc:title', x.title) : '', x.description ? alt('dc:description', x.description) : '', x.rights ? alt('dc:rights', x.rights) : '',
    x.creator ? `<dc:creator><rdf:Seq><rdf:li>${esc(x.creator)}</rdf:li></rdf:Seq></dc:creator>` : '', x.subject?.length ? bag('dc:subject', x.subject) : '', x.hierarchical?.length ? bag('lr:hierarchicalSubject', x.hierarchical) : '',
  ].join('');
  const attrs = [x.rating !== undefined ? `xmp:Rating="${x.rating}"` : '', x.label ? `xmp:Label="${esc(x.label)}"` : '', x.city ? `photoshop:City="${esc(x.city)}"` : '', x.state ? `photoshop:State="${esc(x.state)}"` : '', x.country ? `photoshop:Country="${esc(x.country)}"` : '',
    x.dateCreated ? `photoshop:DateCreated="${esc(x.dateCreated)}"` : '', x.countryCode ? `Iptc4xmpCore:CountryCode="${esc(x.countryCode)}"` : '', x.sublocation ? `Iptc4xmpCore:Location="${esc(x.sublocation)}"` : ''].filter(Boolean).join(' ');
  const xml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:lr="http://ns.adobe.com/lightroom/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" ${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const head = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'); const data = Buffer.from(xml, 'utf8'); const len = 2 + head.length + data.length;
  return Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 255]), head, data]);
}

/** libvips writes GPSAltitudeRef as 0 whatever it is given, so the byte is patched in place (tag 0x0005 of the GPS IFD) for below-sea-level fixtures. */
function setGpsAltitudeBelowSea(jpeg: Buffer): void {
  let i = 2;
  while (i + 4 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1]!, len = jpeg.readUInt16BE(i + 2);
    if (marker === 0xe1 && jpeg.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
      const t = i + 10, le = jpeg.toString('latin1', t, t + 2) === 'II'; const u16 = (o: number) => (le ? jpeg.readUInt16LE(o) : jpeg.readUInt16BE(o)); const u32 = (o: number) => (le ? jpeg.readUInt32LE(o) : jpeg.readUInt32BE(o));
      const ifd0 = t + u32(t + 4); let gps = 0;
      for (let e = 0, n = u16(ifd0); e < n; e++) { const at = ifd0 + 2 + e * 12; if (u16(at) === 0x8825) gps = t + u32(at + 8); }
      for (let e = 0, n = gps ? u16(gps) : 0; e < n; e++) { const at = gps + 2 + e * 12; if (u16(at) === 0x0005) { jpeg[at + 8] = 1; return; } }
      return;
    }
    i += 2 + len;
  }
}

export async function makeJpeg(file: string, o: FakeJpeg = {}): Promise<void> {
  let w = o.width ?? 640, h = o.height ?? 427; const c = o.color ?? { r: 60, g: 120, b: 160 };
  // a deterministic gradient + blocks so perceptual hashes differ between different `pattern` values
  let px = Buffer.alloc(w * h * 3);
  if (o.base) { const r = await sharp(o.base).removeAlpha().raw().toBuffer({ resolveWithObject: true }); px = r.data; w = r.info.width; h = r.info.height; }
  const p = o.pattern ?? 0;
  if (!o.base) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const block = ((Math.floor(x / (w / 4 + p % 7)) + Math.floor(y / (h / 4 + (p >> 3) % 5)) + p) % 2) * 70;
    px[i] = Math.min(255, c.r + block + (x * 40) / w); px[i + 1] = Math.min(255, c.g + (y * 40) / h); px[i + 2] = Math.min(255, c.b + block / 2);
  }
  const ifd2: Record<string, string> = {};
  if (o.captureAt) ifd2.DateTimeOriginal = o.captureAt;
  if (o.subsec) ifd2.SubSecTimeOriginal = o.subsec;
  if (o.lens) ifd2.LensModel = o.lens;
  if (o.focal) ifd2.FocalLength = `${o.focal}/1`;
  if (o.fnumber) ifd2.FNumber = `${Math.round(o.fnumber * 10)}/10`;
  if (o.exposure) ifd2.ExposureTime = o.exposure;
  if (o.iso) ifd2.ISOSpeedRatings = String(o.iso);
  if (o.serial) ifd2.BodySerialNumber = o.serial;
  if (o.offset) ifd2.OffsetTimeOriginal = o.offset;
  const ifd0: Record<string, string> = {};
  if (o.make) ifd0.Make = o.make; if (o.model) ifd0.Model = o.model; if (o.copyright) ifd0.Copyright = o.copyright; if (o.artist) ifd0.Artist = o.artist;
  const exif: Record<string, Record<string, string>> = {};
  if (Object.keys(ifd0).length) exif.IFD0 = ifd0;
  if (Object.keys(ifd2).length) exif.IFD2 = ifd2;
  if (o.gps) exif.IFD3 = { GPSLatitudeRef: o.gps.lat >= 0 ? 'N' : 'S', GPSLatitude: dms(o.gps.lat), GPSLongitudeRef: o.gps.lon >= 0 ? 'E' : 'W', GPSLongitude: dms(o.gps.lon), ...(o.gps.alt !== undefined ? { GPSAltitudeRef: o.gps.alt < 0 ? '1' : '0', GPSAltitude: `${Math.round(Math.abs(o.gps.alt) * 100)}/100` } : {}) };
  let img = sharp(px, { raw: { width: w, height: h, channels: 3 } });
  if (o.profile === 'p3') img = img.withIccProfile('p3');
  if (o.profile === 'adobergb') img = img.withIccProfile('/System/Library/ColorSync/Profiles/AdobeRGB1998.icc');
  if (Object.keys(exif).length) img = img.withExif(exif);
  if (o.orientation) img = img.withMetadata({ orientation: o.orientation });
  let buf = await img.jpeg({ quality: 82 }).toBuffer();
  if (o.gps?.alt !== undefined && o.gps.alt < 0) setGpsAltitudeBelowSea(buf);
  if (o.xmp) buf = Buffer.concat([buf.subarray(0, 2), xmpSegment(o.xmp), buf.subarray(2)]);
  if (o.iptc) buf = Buffer.concat([buf.subarray(0, 2), iptcSegment(o.iptc), buf.subarray(2)]);   // APP13 straight after SOI
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
