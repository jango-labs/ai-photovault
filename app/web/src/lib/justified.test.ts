import { describe, expect, it } from 'vitest';
import { justifiedLayout, rowOfIndex, verticalNeighbour } from './justified';

const mix = (n: number) => Float32Array.from({ length: n }, (_, i) => [1.5, 0.667, 1.778, 1, 1.25, 0.8][i % 6]!);

describe('justifiedLayout', () => {
  it('fills every complete row exactly to the container width', () => {
    const { rows } = justifiedLayout(mix(120), 1200, 200, 4);
    for (const r of rows.slice(0, -1)) {
      const w = r.items.reduce((s, it) => s + it.width, 0) + 4 * (r.items.length - 1);
      expect(w).toBeCloseTo(1200, 3);
    }
  });
  it('never crops or distorts: each cell keeps its photograph\'s aspect ratio', () => {
    const a = mix(60);
    const { rows } = justifiedLayout(a, 1000, 180, 3);
    for (const r of rows) for (const it of r.items) expect(it.width / r.height).toBeCloseTo(a[it.index]!, 4);
  });
  it('keeps the last partial row at the target height instead of blowing it up', () => {
    const { rows } = justifiedLayout(Float32Array.from([1.5, 1.5]), 3000, 200, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.height).toBe(200);
    expect(rows[0]!.last).toBe(true);
  });
  it('contains every photograph exactly once, in order', () => {
    const { rows } = justifiedLayout(mix(257), 900, 150, 2);
    expect(rows.flatMap((r) => r.items.map((i) => i.index))).toEqual(Array.from({ length: 257 }, (_, i) => i));
  });
  it('row tops are contiguous and totalHeight matches', () => {
    const { rows, totalHeight } = justifiedLayout(mix(100), 1000, 160, 3);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.top).toBeCloseTo(rows[i - 1]!.top + rows[i - 1]!.height + 3, 6);
    const last = rows.at(-1)!;
    expect(totalHeight).toBeCloseTo(last.top + last.height, 6);
  });
  it('handles empty input and zero width', () => {
    expect(justifiedLayout([], 1000, 200, 3).rows).toEqual([]);
    expect(justifiedLayout(mix(5), 0, 200, 3).rows).toEqual([]);
  });
  it('clamps very wide single images to the max row height', () => {
    const { rows } = justifiedLayout(Float32Array.from([0.2]), 1000, 200, 3, { maxRowHeight: 300 });
    expect(rows[0]!.height).toBeLessThanOrEqual(300);
  });
  it('lays out 100,000 photographs in well under a second', () => {
    const a = mix(100_000);
    const t = performance.now();
    const { rows } = justifiedLayout(a, 2400, 220, 3);
    const ms = performance.now() - t;
    expect(rows.length).toBeGreaterThan(5000);
    expect(ms).toBeLessThan(500);
  });
  it('rowOfIndex and verticalNeighbour navigate rows', () => {
    const { rows } = justifiedLayout(mix(100), 1000, 160, 3);
    expect(rowOfIndex(rows, 0)).toBe(0);
    const second = rows[1]!.items[0]!.index;
    expect(rowOfIndex(rows, second)).toBe(1);
    expect(rowOfIndex(rows, 99)).toBe(rows.length - 1);
    const down = verticalNeighbour(rows, 0, 1);
    expect(rowOfIndex(rows, down)).toBe(1);
    expect(verticalNeighbour(rows, 0, -1)).toBe(0);                       // top edge: stays
    expect(verticalNeighbour(rows, 99, 1)).toBe(99);                      // bottom edge: stays
  });
});
