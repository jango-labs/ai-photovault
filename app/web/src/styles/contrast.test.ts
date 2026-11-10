import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
const shared = fs.readFileSync(path.join(__dirname, 'aiu-tokens.css'), 'utf8');
// PhotoVault names are aliases of the shared AI Universe tokens: resolve name -> var(--aiu-x) -> #hex (first definition in the shared file).
const token = (name: string): string => {
  const own = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (own?.[1]) return own[1].toLowerCase();
  const alias = css.match(new RegExp(`--${name}:\\s*var\\(--(aiu-[a-z0-9-]+)\\)`));
  const hex = alias?.[1] && shared.match(new RegExp(`--${alias[1]}:\\s*(#[0-9a-fA-F]{6})`));
  if (!hex?.[1]) throw new Error(`token --${name} not found`);
  return hex[1].toLowerCase();
};
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('design tokens meet WCAG AA', () => {
  const surfaces = ['abyss-0', 'abyss-1', 'kelp'];
  const text = ['text', 'text-2', 'text-3', 'mist', 'phosphor', 'aqua', 'ok', 'warn', 'danger'];
  for (const t of text) for (const s of surfaces)
    it(`--${t} on --${s} >= 4.5:1`, () => expect(ratio(token(t), token(s))).toBeGreaterThanOrEqual(4.5));
  it('dark text on the CTA gradient ends >= 4.5:1', () => {
    expect(ratio('#222222', '#cbfffc')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#222222', '#fad1ff')).toBeGreaterThanOrEqual(4.5);
  });
  it('exact directive surface values', () => {
    expect([token('abyss-0'), token('abyss-1'), token('kelp')]).toEqual(['#011d1c', '#012624', '#003734']);
  });
});

// ---- combinations the components actually use ----
import { contrastRatio } from '../lib/contrast';

function over(fg: string, alpha: number, bg: string): string {
  const f = [1, 3, 5].map((i) => parseInt(fg.slice(i, i + 2), 16)), b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  return '#' + f.map((c, i) => Math.round(c * alpha + b[i]! * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

describe('component colour pairs meet WCAG AA (4.5:1 text)', () => {
  it('chrome pills sit on rgba(1,29,28,.72–.78): even over a pure-white photograph the text keeps ≥ 4.5:1', () => {
    for (const a of [0.72, 0.78]) {
      const worst = over('#011d1c', a, '#ffffff');
      for (const fg of ['#ffffff', token('aqua'), token('mist')]) expect(contrastRatio(fg, worst), `${fg} on ${worst}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('status chip text on each surface it can appear on', () => {
    const chips = { draft: token('text-2'), ready: token('aqua'), scheduled: token('aqua'), published: token('mist'), failed: token('danger'), warn: token('warn'), ok: token('ok') };
    for (const [name, c] of Object.entries(chips)) for (const s of ['abyss-0', 'abyss-1']) expect(contrastRatio(c, token(s)), `${name} on ${s}`).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('aqua'), token('kelp'))).toBeGreaterThanOrEqual(4.5);          // SCHEDULED chip fill
    expect(contrastRatio(token('mist'), over('#edfffe', 0.1, token('abyss-0')))).toBeGreaterThanOrEqual(4.5);   // PUBLISHED chip fill
  });
  it('focus ring (aqua) is distinguishable from every surface (≥ 3:1, WCAG 1.4.11)', () => {
    for (const s of ['abyss-0', 'abyss-1', 'kelp']) expect(contrastRatio(token('aqua'), token(s))).toBeGreaterThanOrEqual(3);
  });
  it('the neutral viewer surface keeps text and controls legible', () => {
    expect(contrastRatio('#ffffff', '#2e2e2e')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('text-2'), '#2e2e2e')).toBeGreaterThanOrEqual(4.5);
  });
  it('primary button label on the solid Ice accent (and on its hover, Aqua)', () => {
    expect(contrastRatio('#04201f', '#9dddE0'.toLowerCase())).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#04201f', token('aqua'))).toBeGreaterThanOrEqual(4.5);
  });
  it('dark text on the aurora gradient stops (still used by the AI hairline end stops)', () => {
    for (const stop of ['#cbfffc', '#edfffe', '#fffdfa', '#fad1ff']) expect(contrastRatio('#222222', stop), stop).toBeGreaterThanOrEqual(4.5);
  });
  it('documented exception: teal #00827C is decorative (gradient start), never used for text', () => {
    expect(contrastRatio(token('teal'), token('abyss-0'))).toBeLessThan(4.5);
  });
  it('tertiary text #8FA09E replaces Auros #707777 (which fails)', () => {
    expect(contrastRatio('#707777', token('abyss-1'))).toBeLessThan(4.5);
    expect(contrastRatio(token('text-3'), token('kelp'))).toBeGreaterThanOrEqual(4.5);
  });
});
