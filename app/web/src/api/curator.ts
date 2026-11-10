import { api } from './client';
import type { PhotoCard } from './library';

export interface Reason { factor: string; effect: 'plus' | 'minus' | 'info'; text: string }
export interface Pick { id: string; rank: number; score: number; baseScore: number; reasons: Reason[]; hidden: string[]; seriesSize: number }
export interface Alternative { id: string; score: number; reasons: Reason[] }
export interface CuratorRun {
  id: string; createdAt: string; request: string; purpose: 'general' | 'instagram' | 'portfolio'; count: number;
  understood: Array<{ kind: string; label: string }>; words: string; assumed: string[];
  pool: { matching: number; examined: number }; skipped: { disliked: number; series: number; alreadyInPortfolio: number };
  picks: Pick[]; alternatives: Alternative[]; cards: Record<string, PhotoCard>;
}
export interface RunSummary { id: string; request: string; purpose: string; count: number; picks: number; createdAt: string }
export interface Theme { title: string; request: string; count: number }
export const CURATOR_KEY = ['curator'] as const;

export const runCurator = (b: { request: string; count: number; purpose: CuratorRun['purpose'] }) => api<CuratorRun>('POST', '/api/curator/run', b);
export const fetchRun = (id: string) => api<CuratorRun>('GET', `/api/curator/runs/${id}`);
export const fetchRuns = () => api<{ items: RunSummary[] }>('GET', '/api/curator/runs');
export const fetchThemes = () => api<{ items: Theme[] }>('GET', '/api/curator/themes');
export const sendFeedback = (photoId: string, verdict: 'LIKE' | 'DISLIKE' | 'CLEAR', runId?: string) => api('POST', '/api/curator/feedback', { photoId, verdict, ...(runId ? { runId } : {}) });
export const fetchFeedback = () => api<{ liked: PhotoCard[]; disliked: PhotoCard[] }>('GET', '/api/curator/feedback');
export const saveDraft = (runId: string, photoIds: string[], name?: string) => api<{ id: string; name: string }>('POST', `/api/curator/runs/${runId}/draft`, { photoIds, ...(name ? { name } : {}) });
