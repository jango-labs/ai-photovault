/**
 * How a library photograph is compared with an Instagram image. Pure and explainable; the score is advice for a person, never a decision:
 * only EXACT (byte-identical) and HIGH_CONFIDENCE (visually identical) are assumed, everything else waits for a human, and a person's
 * answer always outranks these numbers.
 */
export interface Signals {
  /** the two files are byte-identical */
  sameBytes: boolean;
  /** 64-bit perceptual / difference hash distances (0 = identical picture) */
  phash: number | null; dhash: number | null;
  /** cosine similarity of the local picture embeddings, −1…1 */
  embedding: number | null;
  /** posted on or after the day the photograph was captured (null when the capture date is unknown) */
  dateConsistent: boolean | null;
  /** word overlap between the caption and the photograph's title/place (0…1) */
  captionOverlap: number;
}
export type MatchState = 'EXACT_MATCH' | 'HIGH_CONFIDENCE_MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH';
export interface Verdict { state: MatchState; score: number }

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
/** measured on faithful re-exports of 30 test pictures: phash 0–4, dhash 2–11, embedding ≈ 1.00; colour-edited copies: phash ≤ 6, embedding 0.88–0.90 */
/** measured on faithful re-exports of 30 test pictures: phash 0–4, dhash 2–11, embedding ≈ 1.00; colour-edited copies: phash ≤ 6, embedding 0.88–0.90; re-exports of blocky demo images drift to phash 6–10 */
export const HIGH_PHASH = 5, HIGH_DHASH = 12, HIGH_EMBEDDING = 0.97, POSSIBLE_MIN_SCORE = 0.45, POSSIBLE_EMBEDDING = 0.95, POSSIBLE_PHASH = 14;

/**
 * Recall matters more than precision below "high confidence": a missed match risks posting the same photograph twice, a wrong proposal costs one click
 * in the review queue. So the picture evidence is the *better* of the hash route (survives re-compression) and the embedding route (survives crops),
 * with the date and the caption as supporting evidence.
 */
export function judge(s: Signals): Verdict {
  if (s.sameBytes) return { state: 'EXACT_MATCH', score: 1 };
  const identical = s.phash !== null && s.dhash !== null && s.phash <= HIGH_PHASH && s.dhash <= HIGH_DHASH && (s.embedding === null || s.embedding >= HIGH_EMBEDDING);
  // an image cannot have been posted before the photograph existed — only a visually identical picture (a wrong capture date) survives that
  if (s.dateConsistent === false && !identical) return { state: 'NO_MATCH', score: 0 };
  if (identical) return { state: 'HIGH_CONFIDENCE_MATCH', score: round(0.9 + 0.1 * (1 - (s.phash! + s.dhash!) / (HIGH_PHASH + HIGH_DHASH))) };
  const viaHash = s.phash === null ? 0 : clamp(1 - s.phash / 16);
  const viaEmbedding = s.embedding === null ? 0 : clamp((s.embedding - 0.92) / 0.08);
  const date = s.dateConsistent === true ? 1 : 0.7;       // an unknown capture date is neutral, not evidence against
  const score = round(0.7 * Math.max(viaHash, viaEmbedding) + 0.15 * date + 0.15 * clamp(s.captionOverlap));
  const plausible = (s.phash !== null && s.phash <= POSSIBLE_PHASH) || (s.embedding !== null && s.embedding >= POSSIBLE_EMBEDDING);
  return plausible && score >= POSSIBLE_MIN_SCORE ? { state: 'POSSIBLE_MATCH', score: Math.min(score, 0.89) } : { state: 'NO_MATCH', score };
}
const round = (x: number) => Math.round(x * 1000) / 1000;

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'on', 'and', 'to', 'for', 'with', 'my', 'is', 'it', 'this', 'that', 'photo', 'image']);
const words = (s: string | null | undefined) => new Set((s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
/** share of the photograph's title/place words that also appear in the caption */
export function captionOverlap(caption: string | null, ...photoTexts: Array<string | null | undefined>): number {
  const cap = words(caption); const ph = new Set(photoTexts.flatMap((t) => [...words(t)]));
  if (!cap.size || !ph.size) return 0; let hit = 0; for (const w of ph) if (cap.has(w)) hit++; return hit / ph.size;
}
export const hashtagsOf = (caption: string | null): string[] => [...new Set([...(caption ?? '').matchAll(/#([\p{L}\p{N}_]{1,60})/gu)].map((m) => m[1]!.toLowerCase()))].slice(0, 60);
