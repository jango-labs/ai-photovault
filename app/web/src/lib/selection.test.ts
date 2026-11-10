import { describe, expect, it } from 'vitest';
import { applyClick, emptySelection, selectAll, toggleOne } from './selection';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
describe('selection model', () => {
  it('plain click selects one and sets the anchor', () => {
    const s = applyClick(emptySelection, ids, 2, {});
    expect([...s.selected]).toEqual(['c']); expect(s.anchor).toBe(2);
  });
  it('plain click replaces the previous selection', () => {
    const s = applyClick(applyClick(emptySelection, ids, 1, {}), ids, 4, {});
    expect([...s.selected]).toEqual(['e']);
  });
  it('toggle adds and removes', () => {
    let s = applyClick(emptySelection, ids, 0, {});
    s = applyClick(s, ids, 3, { toggle: true }); expect([...s.selected].sort()).toEqual(['a', 'd']);
    s = applyClick(s, ids, 0, { toggle: true }); expect([...s.selected]).toEqual(['d']);
  });
  it('shift selects the range from the anchor, in either direction', () => {
    const s = applyClick(applyClick(emptySelection, ids, 4, {}), ids, 1, { shift: true });
    expect([...s.selected].sort()).toEqual(['b', 'c', 'd', 'e']); expect(s.anchor).toBe(4);
  });
  it('shift + toggle extends an existing selection', () => {
    let s = applyClick(emptySelection, ids, 0, {});
    s = applyClick(s, ids, 3, { toggle: true });
    s = applyClick(s, ids, 5, { shift: true, toggle: true });
    expect([...s.selected].sort()).toEqual(['a', 'd', 'e', 'f']);
  });
  it('is immutable and tolerates bad indexes', () => {
    const before = applyClick(emptySelection, ids, 1, {});
    applyClick(before, ids, 2, { toggle: true });
    expect([...before.selected]).toEqual(['b']);
    expect(applyClick(before, ids, 99, {})).toBe(before);
    expect(toggleOne(emptySelection, ids, 5).selected.has('f')).toBe(true);
    expect(selectAll(ids).selected.size).toBe(6);
  });
});
