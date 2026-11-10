import { api } from './client';
import type { PhotoCard } from './library';
import type { PostedCheck } from './instagram';

export type DraftState = 'DRAFT' | 'READY' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';
export interface Schedule { id: string; scheduledAt: string; timezone: string; state: string; attemptCount: number; errorCode: string | null; errorMessage: string | null; publishedAt: string | null; permalink: string | null }
export interface Draft {
  id: string; photoId: string; photo: PhotoCard | null; title: string | null; caption: string; hashtags: string[]; notes: string | null; state: DraftState; createdBy: string;
  approvedAt: string | null; historyCheck: PostedCheck | null; historyOverrideAt: string | null; schedule: Schedule | null; createdAt: string; updatedAt: string;
  captionVersions?: Array<{ id: string; body: string; style: string | null; origin: string; model: string | null; createdAt: string }>;
}
export interface CalendarEntry { id: string; draftId: string; photoId: string; title: string; scheduledAt: string; timezone: string; state: string; error: string | null; caption: string }
export interface CaptionSuggestion { style: 'STORYTELLING' | 'EDUCATIONAL' | 'SHORT'; body: string; model: string; basedOn: string[]; missing: string[] }
export interface HashtagSuggestion { tag: string; reason: string }
export const PUB_KEY = ['publishing'] as const;
export const MAX_CAPTION = 2200, MAX_TAGS = 30;
export const fullLength = (caption: string, tags: string[]) => caption.length + (tags.length ? 2 + tags.map((t) => `#${t}`).join(' ').length : 0);

const P = '/api/publishing';
export const fetchDrafts = (states: DraftState[], cursor?: string) => api<{ items: Draft[]; nextCursor: string | null }>('GET', `${P}/drafts?${[...states.map((s) => `state=${s}`), 'limit=40', ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join('&')}`);
export const fetchDraft = (id: string) => api<Draft>('GET', `${P}/drafts/${id}`);
export const createDraft = (photoId: string, caption = '', hashtags: string[] = []) => api<Draft>('POST', `${P}/drafts`, { photoId, caption, hashtags });
export const patchDraft = (id: string, b: { caption?: string; hashtags?: string[]; title?: string | null; origin?: 'USER' | 'AI' | 'AI_EDITED'; style?: CaptionSuggestion['style']; model?: string }) => api<Draft>('PATCH', `${P}/drafts/${id}`, b);
export const draftAction = <T = Draft>(id: string, action: 'ready' | 'unready' | 'approve' | 'schedule' | 'cancel' | 'reopen', body: unknown = {}) => api<T>('POST', `${P}/drafts/${id}/${action}`, body);
export const reschedule = (scheduleId: string, scheduledAt: string, timezone?: string) => api<Draft>('PATCH', `${P}/schedule/${scheduleId}`, { scheduledAt, ...(timezone ? { timezone } : {}) });
export const cancelSchedule = (scheduleId: string) => api<Draft>('POST', `${P}/schedule/${scheduleId}/cancel`);
export const fetchCalendar = (from: string, to: string) => api<{ items: CalendarEntry[] }>('GET', `${P}/calendar?from=${from}&to=${to}`);
export type SuggestedCaptions = { model: string; note: string; suggestions: Array<CaptionSuggestion & { warnings?: string[] }>; hashtags?: HashtagSuggestion[] };
export const suggestCaptions = (photoId: string, engine: 'template' | 'ollama' = 'template') => api<SuggestedCaptions>('POST', `${P}/captions/suggest`, { photoId, engine });
export const suggestHashtags = (photoId: string) => api<{ suggestions: HashtagSuggestion[] }>('GET', `${P}/hashtags/suggest?photoId=${photoId}`);
export interface Attempt { id: string; phase: string; outcome: string | null; errorCode: string | null; message: string | null; startedAt: string; finishedAt: string | null }
export const fetchAttempts = (draftId: string) => api<{ items: Attempt[] }>('GET', `${P}/drafts/${draftId}/attempts`);
