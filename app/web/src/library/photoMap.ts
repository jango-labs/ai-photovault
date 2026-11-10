import { imageUrl, type PhotoCard, type PhotoDetail as ApiDetail } from '../api/library';
import type { PhotoItem } from '../ui/photo';
import type { PhotoDetail as ViewerDetail } from '../ui/PhotoViewer';

const cache = new WeakMap<PhotoCard, PhotoItem>();

/** API card → grid/viewer view-model. Memoised per card so React.memo thumbnails do not re-render when a later page arrives. */
export function toPhotoItem(c: PhotoCard): PhotoItem {
  const hit = cache.get(c); if (hit) return hit;
  const place = c.location ?? undefined;
  const item: PhotoItem = {
    id: c.id, src: imageUrl(c.id, 'thumb'), full: imageUrl(c.id, 'view'), width: c.width, height: c.height,
    title: c.title, alt: `${c.title}${place ? `, ${place}` : ''}${c.captureAt ? `, ${fmtCapture(c.captureAt, c.captureOffset)}` : ''}`,
    rating: c.rating, favorite: c.favorite, portfolio: c.portfolio, ig: { state: c.ig.state, count: c.ig.count || undefined },
    possibleDuplicate: c.ig.possibleDuplicate, duplicateCandidate: c.duplicateOpen, dominant: c.dominant, place, capturedAt: c.captureAt ? fmtCapture(c.captureAt, c.captureOffset) : undefined,
    processing: c.ai === 'queued' ? 'queued' : c.ai === 'failed' ? 'failed' : undefined,
  };
  cache.set(c, item);
  return item;
}

/** Photographs are dated in the camera's local time, which the file does not record: show the stored calendar date as-is (UTC), never shifted by this browser's zone. */
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** minutes east of UTC from "+05:30" / "-07:00" (null when unknown) */
const offsetMin = (o: string | null | undefined): number | null => { const m = o ? /^([+-])(\d{2}):(\d{2})$/.exec(o) : null; return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };
/** The date as the camera's own clock showed it: the instant moved by the capture's UTC offset (no offset → read as written, in UTC). */
export const fmtCapture = (iso: string, offset: string | null | undefined) => fmtDate(new Date(new Date(iso).getTime() + (offsetMin(offset) ?? 0) * 60_000).toISOString());
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const fmtBytes = (n: number | null) => (n === null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
export const fmtCount = (n: number) => n.toLocaleString('en-GB');

const shutter = (s: number) => (s >= 1 ? `${s} s` : `1/${Math.round(1 / s)} s`);

/** API detail → the viewer's sidebar. Only recorded facts are shown; nothing is inferred or invented. */
export function toViewerDetail(d: ApiDetail | undefined, card: PhotoItem): ViewerDetail {
  if (!d) return { info: { place: card.place, capturedAt: card.capturedAt }, ai: { species: [] }, exif: [], collections: [], history: [], loading: true };
  const e = d.exif;
  const mp = (d.width * d.height) / 1e6;
  const exif: Array<[string, string]> = [];
  if (e.camera) exif.push(['Camera', e.camera]);
  if (e.lens) exif.push(['Lens', e.lens]);
  if (e.focalLengthMm) exif.push(['Focal length', `${Math.round(e.focalLengthMm)} mm`]);
  if (e.aperture) exif.push(['Aperture', `f/${e.aperture}`]);
  if (e.shutterSeconds) exif.push(['Shutter', shutter(e.shutterSeconds)]);
  if (e.iso) exif.push(['ISO', String(e.iso)]);
  if (e.gps) exif.push(['GPS', `${e.gps.lat.toFixed(4)}, ${e.gps.lon.toFixed(4)} (${e.gps.source})`]);
  if (e.photographer) exif.push(['Photographer', e.photographer]);
  if (e.copyright) exif.push(['Copyright', e.copyright]);
  if (e.keywords.length) exif.push(['Keywords', e.keywords.join(', ')]);

  const rows: Array<[string, string]> = [
    ['Filename', d.filename], ['Path', d.relativePath], ['Dimensions', `${d.width} × ${d.height} px · ${mp.toFixed(1)} MP`], ['Orientation', d.orientation],
    ['File size', fmtBytes(d.bytes)], ['Imported', fmtDateTime(d.importedAt)], ['Modified', fmtDateTime(d.modifiedAt)],
  ];
  if (d.exportedAt) rows.push(['Exported', fmtDateTime(d.exportedAt)]);
  if (!d.sourcePresent) rows.push(['Source file', 'Missing from disk']);
  if (d.synthetic) rows.push(['Data', 'Synthetic test photograph']);

  const a = d.ai.analysis;
  const placeholder = a ? undefined
    : d.ai.status === 'queued' ? 'Queued for analysis.'
    : d.ai.status === 'failed' ? 'The last analysis attempt failed.'
    : d.ai.species.length > 0 ? undefined
    : 'Not analysed yet. Analysis runs in the background on this computer; no photograph leaves it.';
  return {
    info: {
      place: d.location ?? undefined,
      placeSource: d.locationSource === 'FOLDER_DERIVED' ? 'Folder' : d.locationSource === 'EXIF' ? 'EXIF GPS' : d.locationSource === 'USER_DEFINED' ? 'You' : d.locationSource === 'AI_INFERRED' ? 'AI inferred' : undefined,
      capturedAt: d.captureAt ? fmtCapture(d.captureAt, d.captureOffset) : 'Not recorded', notes: d.notes ?? undefined,
      version: `${d.versionNo} of ${d.versionCount}`, rows,
    },
    ai: {
      species: d.ai.species.map((s) => ({ name: s.name, scientific: s.scientific ?? undefined, confidence: s.confidence ?? 1, confirmed: s.status === 'CONFIRMED' })),
      behavior: d.ai.species[0]?.behavior ?? undefined, habitat: d.ai.species[0]?.habitat ?? undefined, description: a?.description ?? undefined,
      scores: a ? Object.entries(a.scores).map(([name, value]) => ({ name: name[0]!.toUpperCase() + name.slice(1), value })) : undefined,
      placeholder, provenance: a ? (a.mode === 'mock' ? 'Mock analysis: no AI service was called.' : `${a.provider} · ${a.model}`) : undefined,
    },
    exif, collections: d.collections.map((c) => c.name),
    history: d.history.map((h) => ({ date: fmtDate(h.posted_at), caption: h.caption ?? '', state: h.state, link: h.permalink ?? undefined })),
    publishNote: 'This library is not connected to Instagram, so nothing is sent. Start a draft from the Publish page; a post needs your approval.',
  };
}

/** A deep link (?photo=…) may open a photograph that has not been scrolled into the grid yet: build its card from the detail. */
export function cardFromDetail(d: ApiDetail): PhotoCard {
  return {
    id: d.id, versionId: d.versionId, width: d.width, height: d.height, orientation: d.orientation, title: d.title, filename: d.filename, rating: d.rating, favorite: d.favorite,
    portfolio: d.portfolio, captureAt: d.captureAt, captureOffset: d.captureOffset, year: d.year, folderYear: d.folderYear, location: d.location, importedAt: d.importedAt, ig: d.ig, ai: d.ai.status, synthetic: d.synthetic, dominant: null, duplicateOpen: false,
  };
}
