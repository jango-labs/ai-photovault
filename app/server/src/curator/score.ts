/**
 * The curator's reasoning, as pure functions. It is advisory and fully explainable: every score is a sum of named factors, and
 * every pick carries the sentences that produced it. Nothing here calls a model or touches the database.
 */
export type Purpose = 'general' | 'instagram' | 'portfolio';
export interface Candidate {
  id: string; rating: number; favorite: boolean; portfolio: boolean; captureAt: string | null; location: string | null; species: string | null;
  /** measured quality from the local analysis (0–1), null when not analysed */
  overall: number | null; sharpness: number | null; exposure: number | null;
  postedAt: string | null; liked: boolean; embedding: Float32Array | null;
  /** ids of other candidates that a person (or the duplicate scan) marked as the same photograph */
  duplicates: string[];
}
export interface Reason { factor: 'rating' | 'quality' | 'favourite' | 'portfolio' | 'liked' | 'instagram' | 'variety' | 'series' | 'info'; effect: 'plus' | 'minus' | 'info'; text: string }
export interface Scored { id: string; score: number; reasons: Reason[] }
export interface Pick { id: string; rank: number; score: number; baseScore: number; reasons: Reason[]; hidden: string[]; /** how many frames the series has, this one included (hidden may be shortened for display) */ seriesSize: number }
export interface Selection { picks: Pick[]; alternatives: Scored[]; suppressed: Array<{ id: string; seriesOf: string; why: string }> }

export const SERIES_SIMILARITY = 0.95;
const W_RATING = 0.4, W_QUALITY = 0.25;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const days = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

export function scoreCandidate(c: Candidate, purpose: Purpose, now: Date): Scored {
  const reasons: Reason[] = []; let weight = 0; let sum = 0;
  if (c.rating > 0) { weight += W_RATING; sum += W_RATING * (c.rating / 5); reasons.push({ factor: 'rating', effect: c.rating >= 4 ? 'plus' : 'info', text: `You rated it ${c.rating} star${c.rating > 1 ? 's' : ''}` }); }
  if (c.overall !== null) {
    weight += W_QUALITY; sum += W_QUALITY * c.overall;
    const bits = [c.sharpness !== null ? `sharpness ${r2(c.sharpness)}` : null, c.exposure !== null ? `exposure ${r2(c.exposure)}` : null].filter(Boolean).join(', ');
    reasons.push({ factor: 'quality', effect: c.overall >= 0.6 ? 'plus' : 'info', text: `Measured quality ${r2(c.overall)}${bits ? ` (${bits})` : ''}` });
  }
  let score: number;
  if (weight === 0) { score = 0.3; reasons.push({ factor: 'info', effect: 'info', text: 'Not rated and not analysed yet, so there is little to judge by' }); } else score = sum / weight;
  if (c.favorite) { score += 0.08; reasons.push({ factor: 'favourite', effect: 'plus', text: 'One of your favourites' }); }
  if (c.liked) { score += 0.06; reasons.push({ factor: 'liked', effect: 'plus', text: 'You liked it in an earlier suggestion' }); }
  if (purpose === 'instagram') {
    if (!c.postedAt) { score += 0.1; reasons.push({ factor: 'instagram', effect: 'plus', text: 'Never posted to Instagram' }); }
    else { const d = days(c.postedAt, now); score -= d < 90 ? 0.3 : 0.1; reasons.push({ factor: 'instagram', effect: 'minus', text: `Posted to Instagram ${d} day${d === 1 ? '' : 's'} ago` }); }
  }
  if (purpose === 'portfolio' && !c.portfolio) { score += 0.05; reasons.push({ factor: 'portfolio', effect: 'plus', text: 'Not in your portfolio yet' }); }
  return { id: c.id, score: r2(clamp(score)), reasons };
}

export function cosine(a: Float32Array, b: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; }

/** Picks the best `count`, one per series (near-identical frames), with a gentle push towards variety of subject and place. */
export function select(cands: Candidate[], scored: Scored[], count: number): Selection {
  const by = new Map(cands.map((c) => [c.id, c])); const pool = [...scored].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const picks: Pick[] = []; const suppressed: Selection['suppressed'] = []; const taken = new Set<string>(); const dupOf = new Set<string>();
  const sameSeries = (x: Candidate, y: Candidate) => x.duplicates.includes(y.id) || y.duplicates.includes(x.id) || (x.embedding !== null && y.embedding !== null && cosine(x.embedding, y.embedding) >= SERIES_SIMILARITY);
  while (picks.length < count) {
    let best: { s: Scored; eff: number; vr: Reason[] } | null = null;
    for (const s of pool) {
      if (taken.has(s.id)) continue;
      const c = by.get(s.id)!;
      if (picks.some((p) => sameSeries(c, by.get(p.id)!))) continue;
      const spN = c.species ? picks.filter((p) => by.get(p.id)!.species === c.species).length : 0;
      const loN = c.location ? picks.filter((p) => by.get(p.id)!.location === c.location).length : 0;
      const pen = Math.min(0.3, 0.12 * spN + 0.05 * loN); const eff = s.score - pen;
      if (best && eff <= best.eff) { if (s.score < best.eff) break; continue; }       // pool is sorted: nothing below can beat the best found once its raw score is lower
      const vr: Reason[] = pen > 0 ? [{ factor: 'variety', effect: 'minus', text: spN ? `Variety: ${spN} other ${c.species} photograph${spN > 1 ? 's' : ''} already chosen` : `Variety: ${loN} other photograph${loN > 1 ? 's' : ''} from ${c.location} already chosen` }] : [];
      best = { s, eff, vr };
    }
    if (!best) break;
    taken.add(best.s.id); picks.push({ id: best.s.id, rank: picks.length + 1, score: r2(clamp(best.eff)), baseScore: best.s.score, reasons: [...best.s.reasons, ...best.vr], hidden: [], seriesSize: 1 });
  }
  // everything that is the same series as a pick is hidden behind it (its best frame), not silently dropped
  for (const s of pool) {
    if (taken.has(s.id)) continue;
    const c = by.get(s.id)!; const p = picks.find((k) => sameSeries(c, by.get(k.id)!));
    if (p) { p.hidden.push(s.id); dupOf.add(s.id); suppressed.push({ id: s.id, seriesOf: p.id, why: 'near-identical frame; the best of the series was chosen' }); }
  }
  for (const p of picks) p.seriesSize = p.hidden.length + 1;
  for (const p of picks) if (p.hidden.length) p.reasons.push({ factor: 'series', effect: 'info', text: `Best of ${p.hidden.length + 1} similar frames` });
  const alternatives = pool.filter((s) => !taken.has(s.id) && !dupOf.has(s.id)).slice(0, 8);
  return { picks, alternatives, suppressed };
}
