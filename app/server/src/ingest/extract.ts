import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import exifr from 'exifr';
import sharp from 'sharp';

/** Reads one JPEG (read-only): content hash, dimensions, EXIF / IPTC / XMP. Nothing is inferred; absent data stays absent. */
export interface FileMeta {
  width: number; height: number;
  cameraMake: string | null; cameraModel: string | null; lens: string | null;
  focalLengthMm: number | null; aperture: number | null; shutterSeconds: number | null; iso: number | null;
  /** The capture time exactly as written by the camera (a wall clock), kept as a UTC instant for stable storage. Never shifted. */
  captureAt: Date | null;
  /** The true instant when a UTC offset is known (wall clock minus offset); otherwise the same as captureAt. */
  captureInstant: Date | null;
  /** UTC offset of the capture in minutes (+330 = UTC+05:30) and where it was read from; null when the file does not say. */
  captureOffsetMin: number | null; captureOffsetSource: 'EXIF' | 'XMP' | 'IPTC' | null;
  gps: { lat: number; lon: number; altitudeM: number | null } | null;
  /** IPTC / XMP place names written by Lightroom (independent of GPS and of the folder) */
  place: { city: string | null; state: string | null; country: string | null; countryCode: string | null; sublocation: string | null };
  /** full Lightroom keyword paths ("Wildlife|Mammals|Bison"); `keywords` holds the flat words (including the last element of each path) */
  keywordsHier: string[];
  /** XMP star rating 1–5 (0/absent → null; a "rejected" flag is not a rating) and colour label */
  rating: number | null; colourLabel: string | null;
  copyright: string | null; photographer: string | null; keywords: string[];
  title: string | null; description: string | null;
  identityKey: string | null;
  /** whitelisted, JSON-safe subset of the raw tags */
  exif: Record<string, string | number | boolean | string[]>;
}

export function sha256File(abs: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(abs, { flags: 'r' }).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest()));
  });
}

const str = (v: unknown): string | null => { const s = typeof v === 'string' ? v.replace(/\0/g, '').trim() : typeof v === 'number' ? String(v) : ''; return s ? s.slice(0, 500) : null; };
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;,]/) : []).map((x) => str(x)).filter((x): x is string => !!x);

/** EXIF wall-clock "2024:03:12 06:30:00" kept exactly as written (as UTC); the camera's time zone is not guessed. */
export function parseExifDate(v: unknown, subsec?: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = typeof subsec === 'string' || typeof subsec === 'number' ? Number(String(subsec).padEnd(3, '0').slice(0, 3)) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59), Number.isFinite(ms) ? ms : 0);
  return Number.isNaN(t) ? null : new Date(t);
}

/** XMP language alternatives arrive as { lang, value } (or an array of them); plain strings pass through. */
const alt = (v: unknown): string | null => {
  if (Array.isArray(v)) return alt(v[0]);
  if (v && typeof v === 'object') return str((v as { value?: unknown }).value);
  return str(v);
};
const offsetMinutes = (v: unknown): number | null => {
  const m = typeof v === 'string' ? /^([+-])(\d{2}):?(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null; const min = Number(m[2]) * 60 + Number(m[3]);
  if (min > 14 * 60 + 59 || Number(m[3]) > 59) return null;
  return m[1] === '-' ? -min : min;
};
const wall = (v: unknown): string | null => { const m = typeof v === 'string' ? /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.trim()) : null; return m ? m.slice(1).join('') : null; };

const KEEP = ['City', 'State', 'Country', 'CountryCode', 'Sublocation', 'OffsetTime', 'OffsetTimeDigitized', 'GPSAltitude', 'GPSAltitudeRef', 'Rating', 'Label', 'Make', 'Model', 'LensModel', 'LensMake', 'Software', 'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'FocalLengthIn35mmFormat', 'ExposureProgram', 'ExposureBiasValue',
  'MeteringMode', 'WhiteBalance', 'Flash', 'Orientation', 'ColorSpace', 'Copyright', 'Artist', 'BodySerialNumber', 'LensSerialNumber', 'ImageUniqueID', 'SubSecTimeOriginal', 'OffsetTimeOriginal'];

export async function readMeta(abs: string): Promise<FileMeta> {
  const [img, raw] = await Promise.all([
    sharp(abs, { failOn: 'error' }).metadata(),
    exifr.parse(abs, { tiff: true, ifd0: {}, exif: true, gps: true, iptc: true, xmp: true, icc: false, jfif: false, mergeOutput: true, translateValues: false, reviveValues: false, sanitize: true }).catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);
  const t = raw ?? {};
  let w = img.width ?? 0, h = img.height ?? 0;
  if ((img.orientation ?? 1) >= 5) [w, h] = [h, w];                      // stored sideways: report the displayed size
  if (w <= 0 || h <= 0) throw new Error('not a readable JPEG (no dimensions)');
  const lat = typeof t.latitude === 'number' ? t.latitude : null, lon = typeof t.longitude === 'number' ? t.longitude : null;
  const captureAt = parseExifDate(t.DateTimeOriginal ?? t.CreateDate, t.SubSecTimeOriginal ?? t.SubSecTime);
  // UTC offset: the camera's own OffsetTimeOriginal first; Lightroom's XMP/IPTC date offsets only when their wall clock is the same moment (never a guess)
  const ownWall = wall(t.DateTimeOriginal ?? t.CreateDate);
  let captureOffsetMin = offsetMinutes(t.OffsetTimeOriginal), captureOffsetSource: FileMeta['captureOffsetSource'] = captureOffsetMin !== null ? 'EXIF' : null;
  if (captureOffsetMin === null && ownWall) {
    const x = typeof t.DateCreated === 'string' && /[+-]\d{2}:?\d{2}$/.test(t.DateCreated.trim()) && wall(t.DateCreated) === ownWall ? offsetMinutes(t.DateCreated.trim().slice(-6)) : null;
    if (x !== null) { captureOffsetMin = x; captureOffsetSource = 'XMP'; }
    else { const tc = typeof t.TimeCreated === 'string' ? /^(\d{2})(\d{2})(\d{2})([+-]\d{2}:?\d{2})$/.exec(t.TimeCreated.trim()) : null;
      const o = tc ? offsetMinutes(tc[4]) : null; if (tc && o !== null && ownWall.slice(8) === `${tc[1]}${tc[2]}${tc[3]}`) { captureOffsetMin = o; captureOffsetSource = 'IPTC'; } }
  }
  const captureInstant = captureAt && captureOffsetMin !== null ? new Date(captureAt.getTime() - captureOffsetMin * 60_000) : captureAt;
  const hier = (Array.isArray(t.hierarchicalSubject) ? t.hierarchicalSubject : typeof t.hierarchicalSubject === 'string' ? [t.hierarchicalSubject] : []).map((x: unknown) => str(x)).filter((x: string | null): x is string => !!x).slice(0, 100);
  const leaves = hier.map((h: string) => h.split('|').pop()!.trim()).filter(Boolean);
  const keywords = [...new Set([...list(t.Keywords), ...list(t.subject), ...leaves])].slice(0, 100);
  const cc = str(t.CountryCode); const ratingRaw = Number(t.Rating);
  const altRaw = typeof t.GPSAltitude === 'number' && Number.isFinite(t.GPSAltitude) ? t.GPSAltitude : null;
  const below = (typeof t.GPSAltitudeRef === 'number' ? t.GPSAltitudeRef : t.GPSAltitudeRef && typeof t.GPSAltitudeRef === 'object' ? Number((t.GPSAltitudeRef as Record<string, unknown>)['0']) : 0) === 1;
  const altitudeM = altRaw === null ? null : Math.round((below ? -altRaw : altRaw) * 10) / 10;
  const exif: FileMeta['exif'] = {};
  for (const k of KEEP) {
    const v = t[k];
    if (v instanceof Date) exif[k] = v.toISOString(); else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') exif[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  const dto = str(t.DateTimeOriginal);
  const serial = str(t.BodySerialNumber), uid = str(t.ImageUniqueID);
  return {
    width: w, height: h,
    cameraMake: str(t.Make), cameraModel: str(t.Model), lens: str(t.LensModel ?? t.Lens),
    focalLengthMm: num(t.FocalLength), aperture: num(t.FNumber), shutterSeconds: num(t.ExposureTime), iso: num(Array.isArray(t.ISO) ? t.ISO[0] : t.ISO ?? t.ISOSpeedRatings),
    captureAt, captureInstant, captureOffsetMin, captureOffsetSource,
    gps: lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon, altitudeM: altitudeM !== null && Math.abs(altitudeM) <= 20_000 ? altitudeM : null } : null,
    place: { city: str(t.City), state: str(t.State ?? t.Province), country: str(t.Country), countryCode: cc && /^[A-Za-z]{2,3}$/.test(cc) ? cc.toUpperCase() : null, sublocation: str(t.Sublocation ?? t.Location) },
    keywordsHier: hier, rating: Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null, colourLabel: str(t.Label)?.slice(0, 30) ?? null,
    copyright: str(t.Copyright ?? t.CopyrightNotice) ?? alt(t.rights), photographer: str(t.Artist) ?? alt(t.creator) ?? str(t.Byline),
    keywords, title: str(t.ObjectName ?? t.Headline) ?? alt(t.title), description: str(t.Caption ?? t.ImageDescription) ?? alt(t.description),
    // Capture time + sub-second + body serial + unique id: NOT the file name (names repeat across years and cameras). A time with whole-second
    // resolution only is NOT an identity (a burst of frames shares it), so without a sub-second or a unique id there is no key.
    identityKey: dto && (str(t.SubSecTimeOriginal) || uid) ? [dto, str(t.SubSecTimeOriginal) ?? '', serial ?? '', uid ?? ''].join('|') : null,
    exif,
  };
}
