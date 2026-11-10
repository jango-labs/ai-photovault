import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { PhotoCard, PhotoDetail, PhotoPage, PhotoSet } from '../api/library';

export const PHOTOS_KEY = ['library', 'photos'] as const;
export const DETAIL_KEY = (id: string) => ['library', 'detail', id] as const;

const apply = (c: PhotoCard, set: PhotoSet): PhotoCard => ({
  ...c, ...(set.rating !== undefined ? { rating: set.rating } : {}), ...(set.favorite !== undefined ? { favorite: set.favorite } : {}), ...(set.portfolio !== undefined ? { portfolio: set.portfolio } : {}),
});

/** Optimistically patch loaded photographs (every cached list + any open detail) so the UI answers instantly; the server confirms or the caller reverts. */
export function patchLoaded(qc: QueryClient, match: (id: string) => boolean, set: PhotoSet): void {
  qc.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: PHOTOS_KEY }, (data) => {
    if (!data) return data;
    return { ...data, pages: data.pages.map((pg) => ({ ...pg, items: pg.items.map((c) => (match(c.id) ? apply(c, set) : c)) })) };
  });
  qc.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: ['search', 'results'] }, (data) => {
    if (!data) return data;
    return { ...data, pages: data.pages.map((pg) => ({ ...pg, items: pg.items.map((c) => (match(c.id) ? apply(c, set) : c)) })) };
  });
  qc.setQueriesData<{ items: PhotoCard[] }>({ queryKey: ['search', 'similar'] }, (data) => (data ? { ...data, items: data.items.map((c) => (match(c.id) ? apply(c, set) : c)) } : data));
  qc.setQueriesData<PhotoDetail>({ queryKey: ['library', 'detail'] }, (d) => (d && match(d.id) ? ({ ...d, ...(set.rating !== undefined ? { rating: set.rating } : {}), ...(set.favorite !== undefined ? { favorite: set.favorite } : {}), ...(set.portfolio !== undefined ? { portfolio: set.portfolio } : {}) }) : d));
}
