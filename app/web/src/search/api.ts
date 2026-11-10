import { api } from '../api/client';
import type { PhotoCard } from '../api/library';

export interface Understood { kind: string; label: string }
export interface SearchResult {
  items: PhotoCard[]; total: number; nextOffset: number | null; relaxed: boolean;
  parsed: { text: string; understood: Understood[] }; semantic: { available: boolean; used: boolean; reason: string; model?: string; coverage?: { embedded: number; photos: number } };
}
export interface SimilarResult { items: Array<PhotoCard & { similarity: number }>; model: string }
export interface HistoryItem { id: string; q: string; resultCount: number | null; at: string }
export interface SavedSearch { id: string; name: string; q: string; exclude: string[]; createdAt: string }
export interface Discover { species: Array<{ name: string; n: number }>; places: Array<{ name: string; n: number }>; years: Array<{ year: number; n: number }>; tags: Array<{ name: string; n: number }>; examples: string[] }
export interface SearchStatus { photos: number; indexed: number; embedded: number; embeddingsQueued: number; embeddingModel: string }

export const exclusionKey = (u: Understood) => `${u.kind}:${u.label}`;
export function fetchSearch(q: string, exclude: string[], offset: number, limit = 60): Promise<SearchResult> {
  const p = new URLSearchParams({ q, limit: String(limit), offset: String(offset), record: String(offset === 0) });
  for (const x of exclude) p.append('exclude', x);
  return api<SearchResult>('GET', `/api/search?${p}`);
}
export const fetchSimilar = (id: string) => api<SimilarResult>('GET', `/api/search/similar/${id}?limit=48`);
export const fetchHistory = () => api<{ items: HistoryItem[] }>('GET', '/api/search/history');
export const clearHistory = () => api('DELETE', '/api/search/history');
export const deleteHistory = (id: string) => api('DELETE', `/api/search/history/${id}`);
export const fetchSaved = () => api<{ items: SavedSearch[] }>('GET', '/api/search/saved');
export const saveSearch = (name: string, q: string, exclude: string[]) => api<{ id: string }>('POST', '/api/search/saved', { name, q, exclude });
export const deleteSaved = (id: string) => api('DELETE', `/api/search/saved/${id}`);
export const fetchDiscover = () => api<Discover>('GET', '/api/search/discover');
export const fetchSearchStatus = () => api<SearchStatus>('GET', '/api/search/status');
export const reindexSearch = () => api<{ indexed: number; embeddingsQueued: number }>('POST', '/api/search/reindex');

export const searchHref = (q: string, exclude: string[] = []) => {
  const p = new URLSearchParams(); if (q) p.set('q', q); for (const x of exclude) p.append('x', x);
  return `/search${p.size ? `?${p}` : ''}`;
};
