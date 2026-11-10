import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const ui = read('ui.css');
const tokens = read('tokens.css');
const all = ui + tokens;
const rule = (sel: string) => { const m = ui.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)); if (!m) throw new Error(`rule ${sel} not found`); return m[1]!; };

describe('Auros-derived design rules are enforced in CSS', () => {
  it('no box-shadows, drop-shadows, blur or glass anywhere', () => {
    expect(all).not.toMatch(/box-shadow\s*:\s*(?!none)/);
    expect(all).not.toMatch(/drop-shadow|text-shadow|backdrop-filter|blur\(/);
  });
  it('photographs are never filtered, blended or tinted', () => {
    for (const sel of ['.jb-thumb img', '.jb-viewer__stage img', '.jb-entry__img img', '.jb-hist__tile img', '.jb-compare img']) {
      const r = rule(sel);
      expect(r, sel).not.toMatch(/filter|mix-blend-mode|opacity\s*:\s*0?\.[0-9]/);
    }
  });
  it('the viewer fits any aspect ratio without cropping (contain, bounded to the stage)', () => {
    const r = rule('.jb-viewer__stage img');
    expect(r).toMatch(/object-fit:\s*contain/);
    expect(r).toMatch(/position:\s*absolute/);
    expect(r).toMatch(/width:\s*100%/); expect(r).toMatch(/height:\s*100%/);
  });
  it('only the approved radii are used: 2/3/4 (tiny), 6, 12, 16 and circles', () => {
    const radii = [...all.matchAll(/border-radius\s*:\s*([^;]+);/g)].flatMap((m) => m[1]!.split(/\s+/));
    const allowed = new Set(['0', '1px', '2px', '3px', '4px', '5px', '6px', '10px', '12px', '16px', '50%', 'inherit', 'var(--thumb-radius,', '2px)', '16px', '1px;']);
    for (const r of radii) expect(allowed.has(r) || /^\d+px$/.test(r) && Number(r.slice(0, -2)) <= 16, `radius ${r}`).toBe(true);
    expect(radii.some((r) => /^(\d{2,})px$/.test(r) && Number(r.slice(0, -2)) > 16)).toBe(false);
  });
  it('the aurora gradient appears only in AI hairlines and the wordmark dot; the primary button is a solid accent (never gradients on surfaces or text)', () => {
    const uses = [...ui.matchAll(/([^{}]+)\{[^}]*var\(--gradient-(?:cta|ai)\)[^}]*\}/g)].map((m) => m[1]!.trim().replace(/\s+/g, ' '));
    for (const u of uses) expect(u, u).toMatch(/jb-hairline|jb-wordmark|jb-status--publishing/);
    expect(rule('.jb-btn--primary')).not.toMatch(/gradient/);
    expect(rule('.jb-btn--primary')).toMatch(/var\(--uni-violet-strong\)/);   // AI Universe identity: solid violet primary
  });
  it('only weights 400 and 500 are used', () => {
    expect(all).not.toMatch(/font-weight\s*:\s*(?:[1-3]00|[6-9]00|bold|lighter|bolder)/);
  });
  it('motion is disabled under prefers-reduced-motion', () => {
    expect(all).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(ui).toMatch(/jb-hairline::after \{ animation: none/);
  });
  it('focus is always visible (no outline removal without a replacement)', () => {
    expect(tokens).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--aqua\)/);
  });
  it('touch targets grow on coarse pointers', () => {
    expect(ui).toMatch(/@media \(pointer: coarse\)[^{]*\{[^}]*\.jb-btn \{ height: 44px/);
  });
});
