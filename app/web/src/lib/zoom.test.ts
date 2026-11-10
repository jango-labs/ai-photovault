import { describe, expect, it } from 'vitest';
import { FIT, MAX_SCALE, clampZoom, fittedSize, panBy, toggleZoom, wheelFactor, zoomAt } from './zoom';

const stage = { w: 1000, h: 600 };
const landscape = { w: 6000, h: 4000 }, portrait = { w: 4000, h: 6000 };

describe('viewer zoom model', () => {
  it('fits any aspect ratio inside the stage without cropping', () => {
    expect(fittedSize(stage, landscape)).toEqual({ w: 900, h: 600 });
    expect(fittedSize(stage, portrait)).toEqual({ w: 400, h: 600 });
    expect(fittedSize({ w: 0, h: 0 }, landscape)).toEqual({ w: 0, h: 0 });
  });
  it('never zooms out past fit and never past the maximum', () => {
    expect(zoomAt(FIT, 0.2, { x: 0, y: 0 }, stage, landscape)).toEqual(FIT);
    expect(zoomAt(FIT, 100, { x: 0, y: 0 }, stage, landscape).scale).toBe(MAX_SCALE);
  });
  it('keeps the point under the pointer fixed while zooming', () => {
    const p = { x: 200, y: 100 };
    const z = zoomAt(FIT, 2, p, stage, landscape);
    expect(z.scale).toBe(2);
    // the stage point under the pointer before == after:  (p - pan) / scale is unchanged
    expect((p.x - z.x) / z.scale).toBeCloseTo(p.x / 1, 5);
    expect((p.y - z.y) / z.scale).toBeCloseTo(p.y / 1, 5);
  });
  it('panning is bounded: the photograph always covers the stage on an overflowing axis', () => {
    const z = { scale: 2, x: 0, y: 0 };
    const far = panBy(z, 99999, -99999, stage, landscape);
    expect(far.x).toBe((900 * 2 - 1000) / 2);          // 400
    expect(far.y).toBe(-((600 * 2 - 600) / 2));         // -300
  });
  it('a photograph narrower than the stage cannot be panned sideways', () => {
    const z = clampZoom({ scale: 1.2, x: 500, y: 0 }, stage, portrait);   // 400*1.2 = 480 < 1000
    expect(z.x).toBe(0);
  });
  it('double-click toggles between fit and 2.5×', () => {
    const zoomed = toggleZoom(FIT, { x: 10, y: 10 }, stage, landscape);
    expect(zoomed.scale).toBe(2.5);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, stage, landscape)).toEqual(FIT);
  });
  it('wheel direction: scrolling up zooms in, down zooms out', () => {
    expect(wheelFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, false)).toBeLessThan(1);
    expect(wheelFactor(-100, true)).toBeGreaterThan(wheelFactor(-100, false));
  });
});
