/** Web-Mercator geometry for the Map. Pure functions: a view is {lon, lat, zoom} of the centre; the world is 256·2^zoom pixels wide. */
export interface View { lon: number; lat: number; zoom: number }
export type Bbox = [number, number, number, number];            // west, south, east, north
export const MAX_LAT = 85.0511;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 18;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const worldSize = (zoom: number) => 256 * 2 ** zoom;

export const lonToX = (lon: number, zoom: number) => ((lon + 180) / 360) * worldSize(zoom);
export const latToY = (lat: number, zoom: number) => {
  const r = (clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * worldSize(zoom);
};
export const xToLon = (x: number, zoom: number) => (x / worldSize(zoom)) * 360 - 180;
export const yToLat = (y: number, zoom: number) => {
  const n = Math.PI - (2 * Math.PI * y) / worldSize(zoom);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};

/** screen pixel (relative to the map element) of a coordinate */
export const project = (v: View, w: number, h: number, lon: number, lat: number): [number, number] =>
  [lonToX(lon, v.zoom) - lonToX(v.lon, v.zoom) + w / 2, latToY(lat, v.zoom) - latToY(v.lat, v.zoom) + h / 2];
export const unproject = (v: View, w: number, h: number, x: number, y: number): [number, number] =>
  [xToLon(x - w / 2 + lonToX(v.lon, v.zoom), v.zoom), yToLat(y - h / 2 + latToY(v.lat, v.zoom), v.zoom)];

/** the box of coordinates currently visible, clamped to the world */
export function viewBounds(v: View, w: number, h: number): Bbox {
  const [west, north] = unproject(v, w, h, 0, 0); const [east, south] = unproject(v, w, h, w, h);
  return [clamp(west, -180, 180), clamp(south, -90, 90), clamp(east, -180, 180), clamp(north, -90, 90)];
}
/** keep the centre inside the world and the zoom inside its limits */
export function clampView(v: View, w: number, h: number): View {
  const zoom = clamp(v.zoom, Math.max(MIN_ZOOM, Math.log2(Math.max(w, 256) / 256)), MAX_ZOOM);       // never zoomed out past the world filling the width
  const halfH = h / 2; const S = worldSize(zoom);
  const y = clamp(latToY(v.lat, zoom), Math.min(halfH, S / 2), Math.max(S - halfH, S / 2));
  return { lon: clamp(v.lon, -180, 180), lat: yToLat(y, zoom), zoom };
}
/** the view that shows a box with a margin */
export function fitBbox(b: Bbox, w: number, h: number, pad = 48): View {
  const [west, south, east, north] = b;
  if (west === east && south === north) return { lon: west, lat: south, zoom: 14 };
  const spanX = Math.max(east - west, 1e-6) / 360; const [yN, yS] = [latToY(north, 0), latToY(south, 0)]; const spanY = Math.max(yS - yN, 1e-9) / 256;
  const zoom = clamp(Math.min(Math.log2((w - 2 * pad) / (256 * spanX)), Math.log2((h - 2 * pad) / (256 * spanY))), MIN_ZOOM, MAX_ZOOM);
  return { lon: (west + east) / 2, lat: yToLat((yN + yS) / 2 * 2 ** zoom, zoom), zoom };
}
/** zoom about a screen point so the coordinate under it stays put */
export function zoomAt(v: View, w: number, h: number, x: number, y: number, delta: number): View {
  const zoom = clamp(v.zoom + delta, MIN_ZOOM, MAX_ZOOM); if (zoom === v.zoom) return v;
  const [lon, lat] = unproject(v, w, h, x, y);
  const nx = lonToX(lon, zoom) - (x - w / 2); const ny = latToY(lat, zoom) - (y - h / 2);
  return { lon: xToLon(nx, zoom), lat: yToLat(ny, zoom), zoom };
}
export const panBy = (v: View, dx: number, dy: number): View => ({ lon: xToLon(lonToX(v.lon, v.zoom) - dx, v.zoom), lat: yToLat(latToY(v.lat, v.zoom) - dy, v.zoom), zoom: v.zoom });

export const roundBbox = (b: Bbox, digits = 4): Bbox => b.map((x) => Math.round(x * 10 ** digits) / 10 ** digits) as Bbox;
export const formatView = (v: View) => `${v.lat.toFixed(4)},${v.lon.toFixed(4)},${v.zoom.toFixed(2)}`;
export function parseView(s: string | null): View | null {
  if (!s) return null; const n = s.split(',').map(Number);
  return n.length === 3 && n.every(Number.isFinite) && Math.abs(n[0]!) <= 90 && Math.abs(n[1]!) <= 180 && n[2]! >= MIN_ZOOM && n[2]! <= MAX_ZOOM ? { lat: n[0]!, lon: n[1]!, zoom: n[2]! } : null;
}
