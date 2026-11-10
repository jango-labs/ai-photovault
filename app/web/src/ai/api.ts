import { api } from '../api/client';
import type { LibraryFilters } from '../api/library';

export interface AiSettings { provider: 'local-image' | 'ollama' | 'mock'; autoAnalyze: boolean }
export interface ProviderInfo { id: string; label: string; kind: 'local' | 'mock' | 'live'; available: boolean; ready?: boolean; reason?: string | null; note: string }
export interface AiStatus {
  settings: AiSettings; promptVersion: string; photos: number; analysed: number; stale: number; jobs: Record<string, number>; providers: ProviderInfo[];
  live: { enabled: boolean; lifetimePhotoCap: number; spendRecords: number; spentUsd: number };
}
export interface AnalysisRow { id: string; provider: string; model: string; mode: 'mock' | 'local' | 'live'; promptVersion: string; stale: boolean; createdAt: string; primarySubject: string | null; description: string | null; tags: string[]; scores: Record<string, number | null>; overall: number | null; colours: string[]; lighting: string | null; style: string | null; current: boolean }
export interface SpeciesLink { id: string; name: string; scientific: string | null; confidence: number | null; status: 'SUGGESTED' | 'CONFIRMED' | 'REJECTED'; source: string; behavior: string | null; habitat: string | null; count: number | null; analysis_id: string | null }
export interface CorrectionRow { id: string; kind: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; at: string }
export interface PhotoAi { currentVersionId: string; queued: boolean; analyses: AnalysisRow[]; species: SpeciesLink[]; corrections: CorrectionRow[] }
export type AnalyzeTarget = { ids: string[] } | { query: Partial<LibraryFilters> & { view: string }; exclude: string[] };

export const fetchAiStatus = () => api<AiStatus>('GET', '/api/ai/status');
export const putAiSettings = (p: Partial<AiSettings>) => api<AiSettings>('PUT', '/api/ai/settings', p);
export const fetchPhotoAi = (id: string) => api<PhotoAi>('GET', `/api/ai/photos/${id}`);
export const analyseTarget = (target: AnalyzeTarget, force = false) => api<{ queued: number; alreadyAnalysed: number; waitingForPreviews: number }>('POST', '/api/ai/analyze', { target, force });
export const analysePhoto = (id: string) => api<{ queued: number }>('POST', `/api/ai/photos/${id}/analyze`, { force: true });
export const decideSpecies = (id: string, linkId: string, action: 'confirm' | 'reject') => api('POST', `/api/ai/photos/${id}/species/${linkId}`, { action });
export const addSpecies = (id: string, body: { commonName: string; scientificName?: string | null; replaces?: string }) => api('POST', `/api/ai/photos/${id}/species`, body);
export const acceptDescription = (id: string, analysisId: string) => api('POST', `/api/ai/photos/${id}/accept-description`, { analysisId });

export interface QueueStatus {
  paused: boolean; previewsPaused: boolean; waiting: number; running: number; done24h: number; failed24h: number; cancelled: number; gaveUp: number; prioritised: number;
  secondsPerItem: number | null; etaSeconds: number | null; oldestWaitingSeconds: number | null; perKind: Array<{ kind: string; waiting: number; running: number }>;
}
export interface QueueHistoryRow { id: string; kind: string; outcome: string | null; startedAt: string; seconds: number | null; error: string | null; photoId: string | null; title: string | null }
export const fetchQueue = () => api<QueueStatus>('GET', '/api/ai/queue');
export const fetchQueueHistory = () => api<{ items: QueueHistoryRow[] }>('GET', '/api/ai/queue/history?limit=15');
export const pauseQueue = () => api<QueueStatus>('POST', '/api/ai/queue/pause', { queue: 'ai' });
export const resumeQueue = () => api<QueueStatus>('POST', '/api/ai/queue/resume', { queue: 'ai' });
export const cancelQueue = () => api<{ cancelled: number }>('POST', '/api/ai/queue/cancel', {});
export const prioritizeQueue = (body: { importedWithinHours: number } | { reset: true }) => api<{ updated: number }>('POST', '/api/ai/queue/prioritize', body);
