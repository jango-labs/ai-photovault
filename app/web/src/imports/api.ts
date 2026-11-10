import { api } from '../api/client';

export interface RunRow { id: string; mode: 'DRY_RUN' | 'APPLY'; state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED'; sourcePath: string; startedAt: string; finishedAt: string | null; heartbeatAt: string; counters: Partial<Counters>; error: string | null; resumedFrom: string | null }
export interface Counters { scanned: number; bytes: number; new: number; newVersions: number; moved: number; duplicateFiles: number; versionReview: number; unchanged: number; missing: number; errors: number; skipped: Record<string, number>; directories: number; complete: boolean }
export interface QueueStatus {
  jobs: Array<{ kind: string; state: string; n: number }>;
  derivatives: { pending: number; ready: number; failed: number; missing: number };
  failed: Array<{ id: string; kind: string; state: string; error: string | null; attempts: number; relpath: string | null }>;
  workerSeenAt: string | null;
}
export interface SourceInfo {
  name: string; path: string; type: string; mode: string; available: boolean; unavailableReason: string | null;
  discovered: number | null; imported: number; skipped: number; lastScanAt: string | null; lastScanState: string | null; lastRunAt: string | null; lastRunState: string | null; lastError: string | null;
  scanIntervalMinutes: number; nextScanAt: string | null; scanning: boolean;
  lastScan: { new: number; unchanged: number; moved: number; skipped: number; failed: number; missing: number; duplicates: number } | null;
}
export interface ImportStatus { source: { configured: string | null; dryRunApproved: boolean; applyApproved: boolean; previewsDirectory: boolean; info?: SourceInfo | null }; running: boolean; queue: QueueStatus; lastRun: RunRow | null }
export interface RunItem { id: number; relpath: string; action: string; detail: string | null; sha: string | null }
export interface RunDetail { run: RunRow; items: RunItem[]; nextAfter: number | null; byAction: Record<string, number> }
export interface ReviewItem { id: string; kind: 'VERSION_MATCH' | 'DUPLICATE_FILE'; subject: Record<string, string>; createdAt: string }

export const fetchStatus = () => api<ImportStatus>('GET', '/api/imports/status');
export const fetchRuns = () => api<{ runs: RunRow[] }>('GET', '/api/imports/runs').then((r) => r.runs);
export const fetchRun = (id: string, action?: string, after?: number) => api<RunDetail>('GET', `/api/imports/runs/${id}?limit=50${action ? `&action=${action}` : ''}${after ? `&after=${after}` : ''}`);
export const startRun = (mode: 'DRY_RUN' | 'APPLY') => api<{ runId: string }>('POST', '/api/imports/runs', { mode });
export const cancelRun = (id: string) => api('POST', `/api/imports/runs/${id}/cancel`, {});
export const retryFailed = () => api<{ requeued: number }>('POST', '/api/imports/jobs/retry', {});
export const fetchReview = () => api<{ items: ReviewItem[] }>('GET', '/api/imports/review').then((r) => r.items);
export const decideReview = (id: string, decision: 'SAME_PHOTO' | 'DIFFERENT_PHOTO' | 'ACKNOWLEDGE' | 'SKIP') => api('POST', `/api/imports/review/${id}`, { decision });
