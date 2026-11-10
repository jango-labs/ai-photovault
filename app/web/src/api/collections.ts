import { api } from './client';
import type { PhotoCard, toFilterBody } from './library';

export type Target = { ids: string[] } | { query: ReturnType<typeof toFilterBody>; exclude: string[] };
export interface Collection {
  id: string; name: string; description: string | null; kind: 'MANUAL' | 'SMART' | 'SAVED_SEARCH' | 'AI_DRAFT' | 'PORTFOLIO' | 'PUBLISHING'; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  createdBy: 'USER' | 'AI'; rationale: string | null; count: number | null; cover: string | null; coverIsChosen: boolean; dynamic: boolean;
  filters: Record<string, unknown> | null; search: { q: string; exclude: string[] } | null; updatedAt: string; createdAt: string;
}
export interface CollectionPage { items: PhotoCard[]; total: number; nextCursor: string | null }
export const KIND_LABEL: Record<Collection['kind'], string> = { MANUAL: 'Collection', SMART: 'Smart collection', SAVED_SEARCH: 'Saved search', AI_DRAFT: 'AI draft', PORTFOLIO: 'Portfolio', PUBLISHING: 'Publishing' };

export const COLLECTIONS_KEY = ['collections'] as const;
export const fetchCollections = (status: Collection['status'] = 'ACTIVE') => api<{ items: Collection[] }>('GET', `/api/collections?status=${status}`);
export const fetchCollection = (id: string) => api<Collection>('GET', `/api/collections/${id}`);
export const createCollection = (b: { name: string; description?: string | null; kind?: 'MANUAL' | 'SMART'; filters?: unknown; ids?: string[] }) => api<{ id: string }>('POST', '/api/collections', b);
export const patchCollection = (id: string, b: { name?: string; description?: string | null; coverPhotoId?: string | null; filters?: unknown }) => api('PATCH', `/api/collections/${id}`, b);
export const deleteCollection = (id: string) => api('DELETE', `/api/collections/${id}`);
export const fetchCollectionPhotos = (id: string, cursor?: string) => api<CollectionPage>('GET', `/api/collections/${id}/photos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
export const removeFromCollection = (id: string, ids: string[]) => api<{ removed: number }>('DELETE', `/api/collections/${id}/photos`, { ids });
export const moveInCollection = (id: string, ids: string[], before: string | null) => api<{ moved: number }>('POST', `/api/collections/${id}/move`, { ids, before });
export const setCollectionState = (id: string, action: 'activate' | 'archive') => api('POST', `/api/collections/${id}/${action}`);

/** Adds to a manual collection; explicit id lists are sent in batches of 500. */
export async function addToCollection(id: string, target: Target): Promise<{ added: number; alreadyIn: number }> {
  if (!('ids' in target)) return api('POST', `/api/collections/${id}/photos`, { target });
  let added = 0, alreadyIn = 0;
  for (let i = 0; i < target.ids.length; i += 500) {
    const r = await api<{ added: number; alreadyIn: number }>('POST', `/api/collections/${id}/photos`, { target: { ids: target.ids.slice(i, i + 500) } });
    added += r.added; alreadyIn += r.alreadyIn;
  }
  return { added, alreadyIn };
}
