/**
 * Caption and hashtag suggestions, built locally from facts already recorded about the photograph. This is a TEMPLATE assistant, not a
 * language model: it never invents behaviour, weather or facts — it only arranges what the library knows (title, place, species the person
 * confirmed or accepted, date, equipment) and says what it used and what was missing. A hosted model would sit behind the Phase 8 gateway.
 */
export const CAPTION_MODEL = 'local-template-v1';
export type CaptionStyle = 'STORYTELLING' | 'EDUCATIONAL' | 'SHORT';
export interface PhotoFacts {
  title: string | null; place: string | null; species: Array<{ name: string; scientific: string | null }>; capturedAt: Date | null; description: string | null;
  camera: string | null; lens: string | null; focalLengthMm: number | null; aperture: number | null; shutterS: number | null; iso: number | null; keywords: string[];
}
export interface CaptionSuggestion { style: CaptionStyle; body: string; model: string; basedOn: string[]; missing: string[] }
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const when = (d: Date | null) => (d ? `${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}` : null);
const shutter = (s: number) => (s >= 1 ? `${s} s` : `1/${Math.round(1 / s)} s`);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hashOf = (s: string) => { let h = 0; for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return Math.abs(h); };

export function suggestCaptions(f: PhotoFacts, seed: string): CaptionSuggestion[] {
  const names = f.species.map((s) => s.name); const subject = names.length ? list(names) : null; const date = when(f.capturedAt); const v = hashOf(seed);
  const used = (...pairs: Array<[string, unknown]>) => pairs.filter(([, x]) => !!x && !(Array.isArray(x) && !x.length)).map(([k]) => k);
  const missing: string[] = [];
  if (!subject) missing.push('No species is recorded — confirm one in the viewer for a more specific caption');
  if (!f.place) missing.push('No place is recorded'); if (!date) missing.push('No capture date is recorded');
  const where = f.place ? ` in ${f.place}` : '';
  const short = subject ? `${cap(subject)}${where}${date ? `, ${date}` : ''}.` : f.title ? `${f.title}${where}.` : `A photograph${where}${date ? `, ${date}` : ''}.`;
  const openers = ['Some moments ask you to stay still.', 'Patience was the whole story here.', 'The light decided this one.'];
  const story = [
    f.description ? f.description.trim() : subject ? `${cap(subject)}${where}.` : f.title ? `${f.title}.` : null,
    !f.description && (f.place || date) ? `${f.place ? `Photographed in ${f.place}` : 'Photographed'}${date ? ` in ${date}` : ''}.` : date && f.description ? `${date}${f.place ? `, ${f.place}` : ''}.` : null,
    openers[v % openers.length]!,
  ].filter(Boolean).join('\n\n');
  const tech = [f.camera, f.lens, f.focalLengthMm ? `${Math.round(f.focalLengthMm)} mm` : null, f.aperture ? `f/${f.aperture}` : null, f.shutterS ? shutter(f.shutterS) : null, f.iso ? `ISO ${f.iso}` : null].filter(Boolean) as string[];
  const sci = f.species.filter((s) => s.scientific).map((s) => `${s.name} (${s.scientific})`);
  const edu = [
    subject ? `${cap(sci.length ? list(sci) : subject)}${where}${date ? `, ${date}` : ''}.` : short,
    f.description ? f.description.trim() : null,
    tech.length ? `Shot with ${tech.join(' · ')}.` : null,
  ].filter(Boolean).join('\n\n');
  const basis = used(['title', f.title], ['place', f.place], ['species', f.species], ['date', f.capturedAt], ['your description', f.description], ['equipment', tech.length ? tech : null]);
  return [
    { style: 'SHORT', body: short, model: CAPTION_MODEL, basedOn: basis, missing },
    { style: 'STORYTELLING', body: story, model: CAPTION_MODEL, basedOn: basis, missing },
    { style: 'EDUCATIONAL', body: edu, model: CAPTION_MODEL, basedOn: basis, missing: tech.length ? missing : [...missing, 'No equipment data in the file'] },
  ];
}

export interface HashtagSuggestion { tag: string; reason: string }
const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
export function suggestHashtags(f: PhotoFacts, history: Array<{ tag: string; posts: number }>, max = 30): HashtagSuggestion[] {
  const out = new Map<string, string>(); const add = (t: string, why: string) => { const c = clean(t); if (c.length >= 2 && c.length <= 60 && !out.has(c)) out.set(c, why); };
  for (const s of f.species) { add(s.name, 'the species'); const last = s.name.split(/\s+/).at(-1); if (last && last !== s.name) add(last, 'the species'); }
  if (f.place) add(f.place, 'the place');
  for (const k of f.keywords.slice(0, 12)) add(k, 'a keyword of the photograph');
  if (f.capturedAt) add(MONTH[f.capturedAt.getUTCMonth()]!, 'when it was taken');
  for (const h of history) add(h.tag, `you have used it on ${h.posts} post${h.posts === 1 ? '' : 's'}`);
  add('wildlifephotography', 'a general tag'); add('naturephotography', 'a general tag');
  return [...out].slice(0, max).map(([tag, reason]) => ({ tag, reason }));
}
