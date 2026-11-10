import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import countries from 'world-atlas/countries-110m.json';
import { MAX_LAT, latToY, lonToX } from './geo';

/**
 * An offline outline of the world (Natural Earth 1:110m via the `world-atlas` package, bundled with the app): the Map makes no request to any
 * map-tile server, so nothing about where you photograph leaves this computer. Paths are built once in a fixed 1024-unit square and moved/scaled by SVG.
 */
export const BASE = 1024;
type Ring = ReadonlyArray<readonly [number, number]>;
const pt = ([lon, lat]: readonly [number, number]) => `${((lonToX(lon, 0) / 256) * BASE).toFixed(1)} ${((latToY(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)), 0) / 256) * BASE).toFixed(1)}`;
/** Make longitudes continuous (a ring that crosses the antimeridian would otherwise draw a line across the world). */
function unwrap(r: Ring): Array<[number, number]> {
  const out: Array<[number, number]> = []; let off = 0; let prev: number | null = null;
  for (const [lon, lat] of r) { if (prev !== null) { if (lon + off - prev > 180) off -= 360; else if (lon + off - prev < -180) off += 360; } const x = lon + off; out.push([x, lat]); prev = x; }
  return out;
}
/** The unwrapped ring, plus a copy shifted by ±360° when it sticks out of the world, so both sides of the antimeridian are drawn. */
function shifts(r: Ring): Ring[] {
  const u = unwrap(r); const xs = u.map((p) => p[0]); const lo = Math.min(...xs), hi = Math.max(...xs);
  const out: Ring[] = [u];
  if (hi > 180) out.push(u.map(([x, y]) => [x - 360, y] as [number, number]));
  if (lo < -180) out.push(u.map(([x, y]) => [x + 360, y] as [number, number]));
  return out;
}
const ringD = (r: Ring) => shifts(r).map((x) => `M${x.map(pt).join('L')}Z`).join('');
const lineD = (r: Ring) => shifts(r).map((x) => `M${x.map(pt).join('L')}`).join('');

let cache: { land: string; borders: string } | null = null;
export function basemapPaths(): { land: string; borders: string } {
  if (cache) return cache;
  const topo = countries as unknown as Topology<{ land: GeometryCollection; countries: GeometryCollection }>;
  const land = feature(topo, topo.objects.land) as unknown as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | GeoJSON.Polygon> | GeoJSON.Feature<GeoJSON.MultiPolygon | GeoJSON.Polygon>;
  const geoms = 'features' in land ? land.features.map((f) => f.geometry) : [land.geometry];
  const polys = geoms.flatMap((g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates));
  const borders = mesh(topo, topo.objects.countries, (a, b) => a !== b) as GeoJSON.MultiLineString;
  cache = { land: polys.map((rings) => rings.map((r) => ringD(r as unknown as Ring)).join('')).join(''), borders: borders.coordinates.map((l) => lineD(l as unknown as Ring)).join('') };
  return cache;
}
