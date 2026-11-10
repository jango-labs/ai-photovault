import { describe, expect, it } from 'vitest';
import { basemapPaths } from './basemap';
import { clampView, fitBbox, formatView, lonToX, panBy, parseView, project, roundBbox, unproject, viewBounds, worldSize, xToLon, yToLat, latToY, zoomAt, type View } from './geo';

const W = 900, H = 560;
const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);

describe('Web-Mercator geometry', () => {
  it('the world is 256·2^z pixels wide; longitude is linear, latitude is Mercator', () => {
    expect(worldSize(0)).toBe(256); expect(worldSize(3)).toBe(2048); near(lonToX(0, 0), 128); near(lonToX(-180, 5), 0); near(lonToX(180, 5), worldSize(5));
    near(latToY(0, 4), worldSize(4) / 2); expect(latToY(60, 3)).toBeLessThan(latToY(30, 3));            // north is up
    near(yToLat(latToY(37.77, 9), 9), 37.77); near(xToLon(lonToX(-122.4, 9), 9), -122.4);
  });
  it('projection and its inverse agree, and the centre is the middle of the screen', () => {
    const v: View = { lon: 36.8, lat: -1.3, zoom: 7.3 };
    const [cx, cy] = project(v, W, H, v.lon, v.lat); near(cx, W / 2); near(cy, H / 2);
    for (const [lon, lat] of [[35, -2], [38, 0], [10.75, 59.9], [-70, -33]] as const) { const [x, y] = project(v, W, H, lon, lat); const [lo, la] = unproject(v, W, H, x, y); near(lo, lon, 1e-6); near(la, lat, 1e-6); }
  });
  it('visible bounds enclose the centre and widen as you zoom out', () => {
    const v: View = { lon: 20, lat: 10, zoom: 4 }; const [w, s, e, n] = viewBounds(v, W, H);
    expect(w).toBeLessThan(20); expect(e).toBeGreaterThan(20); expect(s).toBeLessThan(10); expect(n).toBeGreaterThan(10);
    const out = viewBounds({ ...v, zoom: 3 }, W, H); expect(out[2] - out[0]).toBeGreaterThan(e - w);
    for (const b of [w, e]) expect(Math.abs(b)).toBeLessThanOrEqual(180); expect(viewBounds({ lon: 0, lat: 0, zoom: 0.5 }, W, H)).toEqual([-180, expect.any(Number), 180, expect.any(Number)]);
  });
  it('zooming about a point keeps the coordinate under it fixed', () => {
    const v: View = { lon: 15, lat: 25, zoom: 3 }; const x = 640, y = 150; const [lon, lat] = unproject(v, W, H, x, y);
    const z = zoomAt(v, W, H, x, y, 1.5); const [lon2, lat2] = unproject(z, W, H, x, y); near(lon2, lon, 1e-6); near(lat2, lat, 1e-6); expect(z.zoom).toBe(4.5);
    expect(zoomAt(v, W, H, x, y, 100).zoom).toBe(18); expect(zoomAt({ ...v, zoom: 18 }, W, H, x, y, 1)).toEqual({ ...v, zoom: 18 });
  });
  it('panning by a drag moves the map under the finger, by exactly that many pixels', () => {
    const v: View = { lon: 0, lat: 0, zoom: 5 }; const p = panBy(v, 100, -40); const [x, y] = project(p, W, H, v.lon, v.lat); near(x, W / 2 + 100, 1e-6); near(y, H / 2 - 40, 1e-6);
  });
  it('clamps: not zoomed out past the world filling the width, centre kept inside the world', () => {
    expect(clampView({ lon: 0, lat: 0, zoom: 0.5 }, W, H).zoom).toBeGreaterThanOrEqual(Math.log2(W / 256) - 1e-9);
    const c = clampView({ lon: 400, lat: 89, zoom: 5 }, W, H); expect(c.lon).toBe(180); expect(c.lat).toBeLessThan(86);
    const s = clampView({ lon: 0, lat: -89, zoom: 6 }, W, H); expect(s.lat).toBeGreaterThan(-86);
  });
  it('fit shows the whole box with a margin; a single point gets a close-up', () => {
    for (const b of [[34, -3, 37, 0], [-10, 35, 30, 60], [10.7, 59.9, 10.8, 60]] as const) {
      const v = fitBbox([...b], W, H); const [w, s, e, n] = viewBounds(v, W, H); expect(w).toBeLessThanOrEqual(b[0]); expect(e).toBeGreaterThanOrEqual(b[2]); expect(s).toBeLessThanOrEqual(b[1]); expect(n).toBeGreaterThanOrEqual(b[3]);
    }
    expect(fitBbox([5, 5, 5, 5], W, H)).toEqual({ lon: 5, lat: 5, zoom: 14 });
  });
  it('views survive the URL; garbage does not', () => {
    const v: View = { lon: 36.8219, lat: -1.2921, zoom: 7.25 }; expect(parseView(formatView(v))).toEqual(v);
    for (const bad of [null, '', '1,2', 'a,b,c', '95,0,3', '0,200,3', '0,0,30', '0,0,0.1']) expect(parseView(bad), String(bad)).toBeNull();
    expect(roundBbox([1.23456789, 2.5, 3.00000001, 4])).toEqual([1.2346, 2.5, 3, 4]);
  });
});

describe('offline basemap', () => {
  it('ships land and borders as vector paths (no tiles, no network)', () => {
    const { land, borders } = basemapPaths(); expect(land.length).toBeGreaterThan(20_000); expect(borders.length).toBeGreaterThan(5_000);
    expect(land.startsWith('M')).toBe(true); expect(land).toContain('Z'); expect(basemapPaths()).toBe(basemapPaths());
    const nums = land.match(/-?\d+\.\d+/g)!.map(Number); expect(Math.min(...nums)).toBeGreaterThanOrEqual(-1030); expect(Math.max(...nums)).toBeLessThanOrEqual(2060);
  });
  it('no coastline segment jumps across the whole world (antimeridian crossings are unwrapped, not drawn as a line)', () => {
    const { land, borders } = basemapPaths();
    for (const d of [land, borders]) for (const sub of d.split('M').filter(Boolean)) {
      const xs = sub.replace('Z', '').split('L').map((p) => Number(p.split(' ')[0])); for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i]! - xs[i - 1]!), sub.slice(0, 40)).toBeLessThan(512);
    }
  });
});
