import { describe, expect, it } from 'vitest';
import { captionOverlap, hashtagsOf, judge, type Signals } from './match.js';

const sig = (o: Partial<Signals> = {}): Signals => ({ sameBytes: false, phash: null, dhash: null, embedding: null, dateConsistent: null, captionOverlap: 0, ...o });

describe('judging a library photograph against an Instagram image', () => {
  it('identical bytes are an exact match with score 1', () => { expect(judge(sig({ sameBytes: true, phash: 30 }))).toEqual({ state: 'EXACT_MATCH', score: 1 }); });
  it('a faithful re-export (measured: phash ≤ 4, dhash ≤ 11, embedding ≈ 1) is high confidence, never "exact"', () => {
    for (const [p, d] of [[0, 11], [4, 4], [2, 8], [5, 12]] as const) { const v = judge(sig({ phash: p, dhash: d, embedding: 1 })); expect(v.state, `${p}/${d}`).toBe('HIGH_CONFIDENCE_MATCH'); expect(v.score).toBeGreaterThanOrEqual(0.9); expect(v.score).toBeLessThan(1); }
  });
  it('the better the hashes, the higher the score', () => { expect(judge(sig({ phash: 0, dhash: 0, embedding: 1 })).score).toBeGreaterThan(judge(sig({ phash: 5, dhash: 12, embedding: 1 })).score); });
  it('a colour-edited copy (phash 2, embedding 0.89) is NOT assumed: it waits for a person', () => {
    const v = judge(sig({ phash: 2, dhash: 6, embedding: 0.89, dateConsistent: true })); expect(v.state).toBe('POSSIBLE_MATCH'); expect(v.score).toBeLessThan(0.9);
  });
  it('a crop (hashes far apart, picture embedding close) is a possible match, not a confirmed one', () => {
    const v = judge(sig({ phash: 22, dhash: 24, embedding: 0.99, dateConsistent: true, captionOverlap: 0.5 })); expect(v.state).toBe('POSSIBLE_MATCH');
  });
  it('an unrelated picture is no match at all', () => { expect(judge(sig({ phash: 26, dhash: 30, embedding: 0.1 })).state).toBe('NO_MATCH'); expect(judge(sig({ phash: 40, dhash: 40, embedding: -0.1, dateConsistent: true })).state).toBe('NO_MATCH'); });
  it('recall over precision: a re-export whose hash drifted (phash 8, no embedding yet) is still proposed for review, not missed', () => {
    const v = judge(sig({ phash: 8, dhash: 14, dateConsistent: true })); expect(v.state).toBe('POSSIBLE_MATCH');
    expect(judge(sig({ phash: 8, dhash: 14, dateConsistent: null })).state).toBe('POSSIBLE_MATCH');
    expect(judge(sig({ phash: 12, dhash: 20, dateConsistent: true })).state).toBe('NO_MATCH');                       // but a loose hash alone is not enough
  });
  it('without hashes or embedding there is nothing to go on', () => { expect(judge(sig()).state).toBe('NO_MATCH'); expect(judge(sig({ captionOverlap: 1, dateConsistent: true })).state).toBe('NO_MATCH'); });
  it('a post cannot predate the photograph: only a visually identical picture survives, and it is flagged by being the only route', () => {
    expect(judge(sig({ phash: 12, dhash: 10, embedding: 0.95, dateConsistent: false })).state).toBe('NO_MATCH');
    expect(judge(sig({ phash: 1, dhash: 2, embedding: 1, dateConsistent: false })).state).toBe('HIGH_CONFIDENCE_MATCH');
  });
  it('caption and date can nudge a borderline case but cannot create a match by themselves', () => {
    const base = sig({ phash: 13, dhash: 20, embedding: 0.9 }); const plain = judge(base), nudged = judge({ ...base, dateConsistent: true, captionOverlap: 1 });
    expect(nudged.score).toBeGreaterThan(plain.score);
  });
  it('possible scores stay below the "high confidence" band, and are bounded', () => { for (const e of [0.93, 0.97, 0.999]) { const v = judge(sig({ phash: 9, dhash: 30, embedding: e, dateConsistent: true, captionOverlap: 1 })); if (v.state === 'POSSIBLE_MATCH') expect(v.score).toBeLessThan(0.9); } });
});

describe('caption helpers', () => {
  it('overlap is the share of the photograph’s own words found in the caption', () => {
    expect(captionOverlap('Lioness at dawn in Masai Mara #wildlife', 'Lioness at dawn', 'Masai Mara')).toBe(1);
    expect(captionOverlap('Quiet morning', 'Lioness at dawn', 'Kenya')).toBe(0); expect(captionOverlap(null, 'x')).toBe(0); expect(captionOverlap('anything', null)).toBe(0);
    expect(captionOverlap('Elephant herd at the river', 'Elephant bull alone')).toBeCloseTo(1 / 3, 5);
  });
  it('hashtags are extracted lower-cased, de-duplicated, with unicode letters', () => {
    expect(hashtagsOf('Dawn #Wildlife #wildlife #Kenya_2024 #été and not# one')).toEqual(['wildlife', 'kenya_2024', 'été']); expect(hashtagsOf(null)).toEqual([]); expect(hashtagsOf('#'.repeat(5))).toEqual([]);
    expect(hashtagsOf(Array.from({ length: 100 }, (_, i) => `#t${i}`).join(' '))).toHaveLength(60);
  });
});
