import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERIES_SIMILARITY, scoreCandidate, select, type Candidate } from './score.js';

const NOW = new Date('2026-10-09T10:00:00Z');
const unit = (...xs: number[]) => { const v = Float32Array.from(xs); const n = Math.hypot(...v); return v.map((x) => x / n); };
let n = 0;
const cand = (o: Partial<Candidate> = {}): Candidate => ({ id: `c${++n}`, rating: 0, favorite: false, portfolio: false, captureAt: null, location: null, species: null, overall: null, sharpness: null, exposure: null, postedAt: null, liked: false, embedding: null, duplicates: [], ...o });
const score = (c: Candidate, p: 'general' | 'instagram' | 'portfolio' = 'general') => scoreCandidate(c, p, NOW);

describe('scoring', () => {
  it('rises with rating and with measured quality, and says why', () => {
    expect(score(cand({ rating: 5 })).score).toBeGreaterThan(score(cand({ rating: 3 })).score);
    expect(score(cand({ overall: 0.9 })).score).toBeGreaterThan(score(cand({ overall: 0.4 })).score);
    const s = score(cand({ rating: 5, overall: 0.8, sharpness: 0.9, exposure: 0.7 }));
    expect(s.reasons.map((r) => r.text)).toEqual(['You rated it 5 stars', 'Measured quality 0.8 (sharpness 0.9, exposure 0.7)']); expect(s.score).toBeCloseTo(0.9, 1);
  });
  it('an unrated, unanalysed photograph is not guessed about: low score and a plain sentence saying so', () => {
    const s = score(cand()); expect(s.score).toBe(0.3); expect(s.reasons).toEqual([expect.objectContaining({ factor: 'info', text: expect.stringContaining('little to judge by') })]);
  });
  it('your favourites and earlier "likes" count; both are named', () => {
    const base = score(cand({ rating: 4 })).score; const s = score(cand({ rating: 4, favorite: true, liked: true }));
    expect(s.score).toBeGreaterThan(base); expect(s.reasons.map((r) => r.factor)).toEqual(['rating', 'favourite', 'liked']);
  });
  it('Instagram: never posted is a plus, recently posted a strong minus, long ago a mild one — but only for Instagram selections', () => {
    const never = score(cand({ rating: 4 }), 'instagram'), recent = score(cand({ rating: 4, postedAt: '2026-10-01T00:00:00Z' }), 'instagram'), old = score(cand({ rating: 4, postedAt: '2025-01-01T00:00:00Z' }), 'instagram');
    expect(never.score).toBeGreaterThan(old.score); expect(old.score).toBeGreaterThan(recent.score);
    expect(recent.reasons.at(-1)!.text).toBe('Posted to Instagram 8 days ago'); expect(score(cand({ rating: 4, postedAt: '2026-10-01T00:00:00Z' }), 'general').score).toBe(score(cand({ rating: 4 }), 'general').score);
  });
  it('portfolio: not yet in the portfolio is a small plus', () => {
    expect(score(cand({ rating: 4 }), 'portfolio').score).toBeGreaterThan(score(cand({ rating: 4, portfolio: true }), 'portfolio').score);
  });
  it('scores stay within 0–1', () => { for (const c of [cand({ rating: 5, overall: 1, favorite: true, liked: true }), cand({ rating: 1, postedAt: '2026-10-08T00:00:00Z' })]) { const s = score(c, 'instagram').score; expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); } });
});

describe('selection', () => {
  const pickIds = (cs: Candidate[], count: number, p: 'general' | 'instagram' | 'portfolio' = 'general') => select(cs, cs.map((c) => score(c, p)), count);

  it('takes the best N in order, with ranks, and returns each candidate at most once', () => {
    const cs = [cand({ rating: 3 }), cand({ rating: 5 }), cand({ rating: 4 }), cand({ rating: 1 })];
    const s = pickIds(cs, 3); expect(s.picks.map((p) => p.id)).toEqual([cs[1]!.id, cs[2]!.id, cs[0]!.id]); expect(s.picks.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(s.alternatives.map((a) => a.id)).toEqual([cs[3]!.id]); expect(new Set([...s.picks.map((p) => p.id), ...s.alternatives.map((a) => a.id)]).size).toBe(4);
  });
  it('asking for more than exists returns what exists; an empty pool returns nothing', () => {
    expect(pickIds([cand({ rating: 5 })], 12).picks).toHaveLength(1); expect(pickIds([], 5)).toEqual({ picks: [], alternatives: [], suppressed: [] });
  });
  it('a burst of near-identical frames yields ONE pick (the best frame), the others hidden behind it and counted', () => {
    const e = unit(1, 0.01, 0, 0);
    const burst = [cand({ rating: 3, embedding: e }), cand({ rating: 5, embedding: unit(1, 0.02, 0, 0) }), cand({ rating: 4, embedding: unit(1, 0.015, 0, 0) })];
    const other = cand({ rating: 4, embedding: unit(0, 0, 1, 0) });
    const s = pickIds([...burst, other], 4);
    expect(s.picks.map((p) => p.id)).toEqual([burst[1]!.id, other.id]); expect(s.picks[0]!.hidden.sort()).toEqual([burst[0]!.id, burst[2]!.id].sort());
    expect(s.picks[0]!.reasons.at(-1)).toMatchObject({ factor: 'series', text: 'Best of 3 similar frames' }); expect(s.suppressed).toHaveLength(2); expect(s.alternatives).toEqual([]);
  });
  it('frames a person marked as duplicates are one series even when their pictures differ', () => {
    const a = cand({ rating: 5 }); const b = cand({ rating: 4, duplicates: [a.id] });
    expect(pickIds([a, b], 2).picks.map((p) => p.id)).toEqual([a.id]);
  });
  it('similarity threshold is respected: moderately alike pictures are both kept', () => {
    const a = cand({ rating: 5, embedding: unit(1, 0, 0, 0) }); const b = cand({ rating: 4, embedding: unit(1, 0.5, 0, 0) });
    expect(SERIES_SIMILARITY).toBe(0.95); expect(pickIds([a, b], 2).picks).toHaveLength(2);
  });
  it('nudges towards variety: an equally good photograph of another species is taken before a second of the same one, and it says so', () => {
    const l1 = cand({ rating: 5, species: 'Lion', location: 'Kenya' }), l2 = cand({ rating: 5, species: 'Lion', location: 'Kenya' }), e1 = cand({ rating: 5, species: 'Elephant', location: 'Kenya' });
    const s = pickIds([l1, l2, e1], 3);
    expect(s.picks.map((p) => p.id)).toEqual([l1.id, e1.id, l2.id]);
    expect(s.picks[2]!.reasons.some((r) => r.factor === 'variety' && /Lion/.test(r.text))).toBe(true); expect(s.picks[2]!.score).toBeLessThan(s.picks[2]!.baseScore);
    expect(s.picks[0]!.reasons.some((r) => r.factor === 'variety')).toBe(false);
  });
  it('variety is a nudge, not a ban: a clearly better photograph of the same species still wins', () => {
    const best = cand({ rating: 5, species: 'Lion' }), second = cand({ rating: 5, species: 'Lion' }), weak = cand({ rating: 2, species: 'Elephant' });
    expect(pickIds([best, second, weak], 2).picks.map((p) => p.id)).toEqual([best.id, second.id]);
  });
  it('is deterministic and gives every pick at least one stated reason', () => {
    const cs = Array.from({ length: 30 }, (_, i) => cand({ rating: i % 6, overall: i % 3 === 0 ? 0.5 + (i % 5) / 10 : null, species: i % 2 ? 'Lion' : 'Leopard' }));
    const a = pickIds(cs, 10), b = pickIds(cs, 10);
    expect(a).toEqual(b); for (const p of a.picks) expect(p.reasons.length).toBeGreaterThan(0);
  });
});

describe('the curator has no way to publish', () => {
  it('nothing under src/curator names a publishing table, a scheduler, an Instagram/Graph client or a delivery token', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const forbidden = /publishing_drafts|scheduled_publications|publication_attempts|caption_versions|delivery_tokens|social_accounts|graph\.facebook|graph\.instagram|media_publish|from '\.\.\/publish|from '\.\.\/instagram|from '\.\.\/delivery/i;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && !x.endsWith('.itest.ts'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
      expect(text.match(forbidden), `${f} mentions a publishing capability`).toBeNull();
    }
  });
});
