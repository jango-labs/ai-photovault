import { api } from './client';
import { bboxParam, toSearchParams, type GpsFilter, type LibraryQuery } from './library';

export interface Cluster { lat: number; lon: number; count: number; sources: Partial<Record<Exclude<GpsFilter, 'none'>, number>>; photoId: string; bbox: [number, number, number, number] }
export interface ClusterResult { clusters: Cluster[]; shown: number; zoom: number }
export interface MapSummary { total: number; placed: number; withoutCoordinates: number; withPlaceNameOnly: number; /** of those, place names you typed yourself (a lookup can place these) */ typedPlaceNameOnly: number; sources: Partial<Record<Exclude<GpsFilter, 'none'>, number>> }

/** The filters of a Library query as map parameters (no sort/paging/area; the map supplies its own box). */
function filterParams(q: LibraryQuery): URLSearchParams {
  const p = toSearchParams({ ...q, filters: { ...q.filters, bbox: undefined } }); p.delete('sort'); p.delete('dir'); return p;
}
export function fetchClusters(q: LibraryQuery, bbox: readonly number[], zoom: number): Promise<ClusterResult> {
  const p = filterParams(q); p.set('bbox', bboxParam(bbox)); p.set('zoom', String(Math.round(zoom)));
  return api<ClusterResult>('GET', `/api/map/clusters?${p}`);
}
export function fetchMapSummary(q: LibraryQuery): Promise<MapSummary> {
  const p = filterParams({ ...q, filters: { ...q.filters, gps: [] } }); return api<MapSummary>('GET', `/api/map/summary?${p}`);
}
