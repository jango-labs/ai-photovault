/**
 * Natural-language query → structured filters + leftover words. Deterministic and explainable: every phrase that was understood is
 * reported back ("Understood as …") so the photographer can see — and remove — what the system assumed. It never calls a language
 * model, so no photograph or query text leaves the machine, and nothing is guessed silently.
 */
export interface SearchContext {
  locations: string[]; species: Array<{ name: string; scientific: string | null }>; cameras: string[]; lenses: string[];
  now?: Date;
}
export interface ParsedFilters {
  year: number[]; month: number[]; rating: number[]; favorite?: boolean; portfolio?: boolean; ig: Array<'posted' | 'never'>;
  orientation: Array<'landscape' | 'portrait' | 'square'>; location: string[]; species: string[]; camera: string[]; lens: string[]; colour: string[]; tag: string[];
}
export interface Understood { kind: 'year' | 'month' | 'rating' | 'favorite' | 'portfolio' | 'instagram' | 'orientation' | 'location' | 'species' | 'camera' | 'lens' | 'colour' | 'tone'; label: string }
export interface ParsedQuery { text: string; filters: ParsedFilters; understood: Understood[]; original: string }

export const emptyParsed = (): ParsedFilters => ({ year: [], month: [], rating: [], ig: [], orientation: [], location: [], species: [], camera: [], lens: [], colour: [], tag: [] });
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const COLOURS = ['red', 'orange', 'amber', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'black', 'white', 'grey', 'gray'];
const STOP = new Set(['photo', 'photos', 'photograph', 'photographs', 'picture', 'pictures', 'image', 'images', 'shot', 'shots', 'of', 'in', 'from', 'with', 'the', 'a', 'an', 'and', 'my', 'me', 'show', 'find', 'all', 'only', 'that', 'are', 'were', 'is', 'i', 'have', 'taken', 'take', 'by', 'at', 'on', 'to', 'for', 'some', 'any', 'get', 'give', 'list', 'which', 'what', 'where', 'when', 'ones', 'one', 'those', 'these', 'it', 'them', 'been', 'has', 'had', 'be', 'or', 'during', 'around', 'near', 'about']);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = (src: string) => `(?<![a-z0-9])(?:${src})(?![a-z0-9])`;
const plural = (w: string) => (w.endsWith('s') ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`);

/** all spellings under which a name could appear: "African elephant" → "african elephant(s)", "elephant(s)" is NOT assumed (too loose) unless the name is one word */
function nameForms(name: string): string[] {
  const n = name.toLowerCase().trim(); const words = n.split(/\s+/);
  const forms = [n, plural(n)];
  if (words.length > 1) { const last = words[words.length - 1]!; forms.push(`${words.slice(0, -1).join(' ')} ${plural(last)}`); }
  return [...new Set(forms)];
}

export function parseQuery(original: string, ctx: SearchContext): ParsedQuery {
  const f = emptyParsed(); const understood: Understood[] = []; const now = ctx.now ?? new Date();
  let s = ` ${original.toLowerCase().replace(/[“”"]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void): boolean => { let hit = false; s = s.replace(re, (...args) => { const m = args as unknown as RegExpExecArray; fn(m); hit = true; return ' '; }); return hit; };
  const say = (kind: Understood['kind'], label: string) => { if (!understood.some((u) => u.kind === kind && u.label === label)) understood.push({ kind, label }); };

  // ---- Instagram state
  take(/\b(?:never|not yet|not|haven'?t|hasn'?t|yet to be)\s+(?:been\s+|be\s+)?(?:posted|published|shared|uploaded)(?:\s+(?:to|on)\s+instagram)?\b|\bunposted\b|\bunpublished\b|\bnot on instagram\b/g, () => { f.ig.push('never'); say('instagram', 'never posted'); });
  take(/\b(?:already\s+|previously\s+)?(?:posted|published|shared)(?:\s+(?:to|on)\s+instagram)?\b|\bon instagram\b/g, () => { if (!f.ig.includes('posted')) f.ig.push('posted'); say('instagram', 'posted'); });

  // ---- ratings
  take(/\b(?:top|best|highest)[- ]rated\b|\bmy best\b|\bbest\b|\btop\b/g, () => { f.rating.push(4, 5); say('rating', '4–5 stars'); });
  take(/\bunrated\b/g, () => { f.rating.push(0); say('rating', 'unrated'); });
  take(/\b(?:rated\s+)?(\d|one|two|three|four|five)(\s*\+)?[ -]*stars?\b(\s*(?:\+|and up|or (?:more|higher|better)|plus))?/g, (m) => { const n = WORD_NUM[m[1]!] ?? Number(m[1]); if (n >= 1 && n <= 5) { const up = !!(m[2] || m[3]); for (let r = n; r <= (up ? 5 : n); r++) f.rating.push(r); say('rating', up ? `${n}+ stars` : `${n} star${n > 1 ? 's' : ''}`); } });
  f.rating = [...new Set(f.rating)].sort();

  // ---- flags
  take(/\bfavou?rites?\b|\bfavou?rited\b/g, () => { f.favorite = true; say('favorite', 'favourites'); });
  take(/\bportfolio\b/g, () => { f.portfolio = true; say('portfolio', 'portfolio'); });

  // ---- orientation
  take(/\bportrait(?:[- ](?:orientation|format))?\b|\bvertical\b|\btall\b/g, () => { f.orientation.push('portrait'); say('orientation', 'portrait'); });
  take(/\blandscape[- ](?:orientation|format)\b|\bhorizontal\b|\bwide\b/g, () => { f.orientation.push('landscape'); say('orientation', 'landscape'); });
  take(/\bsquare\b/g, () => { f.orientation.push('square'); say('orientation', 'square'); });

  // ---- time
  take(/\b(?:from|between)\s+((?:19|20)\d{2})\s*(?:to|and|-|–|until)\s*((?:19|20)\d{2})\b/g, (m) => { let a = Number(m[1]), b = Number(m[2]); if (a > b) [a, b] = [b, a]; for (let y = a; y <= Math.min(b, a + 40); y++) f.year.push(y); say('year', `${a}–${b}`); });
  take(/\bsince\s+((?:19|20)\d{2})\b/g, (m) => { for (let y = Number(m[1]); y <= now.getUTCFullYear(); y++) f.year.push(y); say('year', `since ${m[1]}`); });
  take(/\bbefore\s+((?:19|20)\d{2})\b/g, (m) => { for (let y = Math.max(1990, Number(m[1]) - 40); y < Number(m[1]); y++) f.year.push(y); say('year', `before ${m[1]}`); });
  take(/\blast year\b/g, () => { f.year.push(now.getUTCFullYear() - 1); say('year', String(now.getUTCFullYear() - 1)); });
  take(/\bthis year\b/g, () => { f.year.push(now.getUTCFullYear()); say('year', String(now.getUTCFullYear())); });
  take(/\b((?:19|20)\d{2})\b/g, (m) => { f.year.push(Number(m[1])); say('year', m[1]!); });
  take(new RegExp(`\\b(${MONTHS.join('|')})\\b`, 'g'), (m) => { f.month.push(MONTHS.indexOf(m[1]!) + 1); say('month', m[1]![0]!.toUpperCase() + m[1]!.slice(1)); });
  f.year = [...new Set(f.year)].sort((a, b) => a - b); f.month = [...new Set(f.month)].sort((a, b) => a - b);

  // ---- things that exist in THIS library: species first (so "blue whale" is a species, not the colour blue), then places, equipment
  const lastWord = (n: string) => n.toLowerCase().trim().split(/\s+/).pop()!;
  const heads = new Map<string, number>(); for (const sp of ctx.species) heads.set(lastWord(sp.name), (heads.get(lastWord(sp.name)) ?? 0) + 1);
  const speciesByLen = [...ctx.species].sort((a, b) => b.name.length - a.name.length);
  const chosen = new Set<string>();
  const speciesPass = (formsOf: (sp: { name: string; scientific: string | null }) => string[]) => {
    for (const sp of speciesByLen) {
      if (chosen.has(sp.name)) continue;
      const forms = formsOf(sp).sort((a, b) => b.length - a.length); if (!forms.length) continue;
      if (take(new RegExp(B(forms.map(esc).join('|')), 'g'), () => undefined)) { chosen.add(sp.name); f.species.push(sp.name); say('species', sp.name); }
    }
  };
  speciesPass((sp) => [...nameForms(sp.name), ...(sp.scientific ? [sp.scientific.toLowerCase()] : [])]);
  // a bare head noun ("elephants") selects the species when it is unambiguous in this library
  // …but never for a generic class word: a one-off suggestion such as "small speckled bird" must not turn "birds" into a single-photograph species filter
  const GENERIC_HEADS = new Set(['bird', 'birds', 'animal', 'animals', 'mammal', 'mammals', 'fish', 'insect', 'insects', 'reptile', 'reptiles', 'creature', 'creatures', 'wildlife', 'plant', 'plants', 'flower', 'flowers', 'tree', 'trees']);
  speciesPass((sp) => (heads.get(lastWord(sp.name)) === 1 && !GENERIC_HEADS.has(lastWord(sp.name)) ? nameForms(lastWord(sp.name)) : []));
  for (const loc of [...ctx.locations].sort((a, b) => b.length - a.length)) if (take(new RegExp(B(esc(loc.toLowerCase())), 'g'), () => undefined)) { f.location.push(loc); say('location', loc); }
  for (const cam of ctx.cameras) {
    const toks = cam.toLowerCase().split(/\s+/); const i = toks.findIndex((t) => /\d/.test(t));
    if (i < 0) continue;
    const distinct = i > 0 && toks[i - 1]!.length === 1 ? `${toks[i - 1]} ${toks[i]}` : toks[i]!;
    const body = esc(distinct).replace(/ /g, '\\s*');
    if (new RegExp(`(?:^|[^a-z0-9])${body}(?:[^a-z0-9]|$)`).test(s) && ctx.cameras.filter((c) => c.toLowerCase().includes(distinct)).length === 1) {
      take(new RegExp(`(?:(?<![a-z0-9])(?:canon|nikon|sony|fujifilm|olympus|om system)\\s+)?(?:eos\\s+)?(?<![a-z0-9])${body}(?![a-z0-9])`, 'g'), () => undefined); f.camera.push(cam); say('camera', cam);
    }
  }
  // a bare make ("my Sony camera", "iPhone photos" is a model, handled above) selects every camera of that make in this library
  for (const mk of new Set(ctx.cameras.map((c) => c.toLowerCase().split(/\s+/)[0]!).filter((m) => /^[a-z]{3,}$/.test(m)))) {
    const labels = ctx.cameras.filter((c) => c.toLowerCase().startsWith(`${mk} `));
    if (!labels.length || labels.every((l) => f.camera.includes(l))) continue;
    if (take(new RegExp(`(?<![a-z0-9])${esc(mk)}(?:\\s+(?:cameras?|bod(?:y|ies)|phones?))?(?![a-z0-9])`, 'g'), () => undefined)) for (const l of labels) { if (!f.camera.includes(l)) f.camera.push(l); say('camera', l); }
  }
  const lensHits: Array<{ lens: string; re: RegExp }> = [];
  for (const lens of ctx.lenses) {
    const range = /(\d{2,4})\s*-\s*(\d{2,4})\s*mm/i.exec(lens) ?? /(\d{2,4})\s*mm/i.exec(lens);
    if (!range) continue;
    const re = new RegExp(`(?<![a-z0-9])${range[2] && range[2] !== range[1] ? `${range[1]}\\s*-\\s*${range[2]}` : range[1]}\\s*mm(?![a-z0-9])`);
    if (re.test(s)) lensHits.push({ lens, re });
  }
  // every lens of that focal length is selected (a query cannot tell a 400 mm f/2.8 from a 400 mm TC), and the words are consumed once
  for (const { lens } of lensHits) { f.lens.push(lens); say('lens', lens); }
  for (const re of new Set(lensHits.map((h) => h.re.source))) take(new RegExp(re, 'g'), () => undefined);

  // ---- looks (measured by the local analysis; they only match photographs that have been analysed)
  const tone = (re: RegExp, tag: string, label: string) => take(re, () => { if (!f.tag.includes(tag)) f.tag.push(tag); say('tone', label); });
  tone(/\bwarm(?: tones?| light)?\b/g, 'warm tones', 'warm tones'); tone(/\bcool(?: tones?| light)?\b|\bcold tones?\b/g, 'cool tones', 'cool tones');
  tone(/\b(?:dark|low[- ]key|moody)\b/g, 'low-key exposure', 'dark / low-key'); tone(/\b(?:bright|high[- ]key|airy)\b/g, 'high-key exposure', 'bright / high-key');
  tone(/\b(?:sharp|crisp)\b/g, 'sharp', 'sharp'); tone(/\bsoft(?: focus)?\b/g, 'soft focus', 'soft focus'); tone(/\bhigh contrast\b/g, 'high contrast', 'high contrast'); tone(/\blow contrast\b/g, 'low contrast', 'low contrast');
  tone(/\bmonochrome\b|\bblack and white\b|\bb&w\b/g, 'near monochrome', 'near monochrome'); tone(/\bcolou?rful\b|\bvibrant\b/g, 'colourful', 'colourful');
  take(new RegExp(`\\b(${COLOURS.join('|')})\\b`, 'g'), (m) => { const c = m[1] === 'gray' ? 'grey' : m[1]!; if (!f.colour.includes(c)) f.colour.push(c); say('colour', c); });

  // ---- what remains is searched as words
  const words = s.split(/[^a-z0-9'-]+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w));
  return { text: words.join(' '), filters: f, understood, original };
}

/** UI → API: the structured part of a parsed query as library-style filter fields. */
export const hasStructure = (f: ParsedFilters): boolean => Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined));
