import { api } from './client';
import type { PhotoCard } from './library';

export type PostMatchState = 'EXACT_MATCH' | 'HIGH_CONFIDENCE_MATCH' | 'POSSIBLE_MATCH' | 'USER_CONFIRMED';
export interface IgAccount {
  account: { id: string; username: string | null; type: string | null; status: 'CONNECTED' | 'EXPIRED' | 'DISCONNECTED' | 'ERROR'; synthetic: boolean; lastSyncAt: string | null; lastError: string | null } | null;
  stats: { posts: number; matched: number; review: number; unmatched: number }; syncing: boolean;
  lastRun: { startedAt: string; finishedAt: string | null; status: 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED'; postsSeen: number; postsNew: number; mediaFailed: number; matched: number; error: string | null } | null;
  capabilities: { synthetic: boolean; live: boolean };
}
export interface IgPost {
  id: string; postedAt: string; caption: string | null; hashtags: string[]; permalink: string | null; synthetic: boolean; mediaId: string | null; mediaCount: number;
  match: { id: string; state: PostMatchState; score: number | null; photoId: string; photoTitle: string } | null;
}
export type IgFilter = 'all' | 'matched' | 'review' | 'unmatched';
export interface IgHistory { items: IgPost[]; nextCursor: string | null; counts: Record<IgFilter, number> }
export interface ReviewItem {
  matchId: string; score: number; signals: { phash?: number | null; dhash?: number | null; embedding?: number | null; dateConsistent?: boolean | null; captionOverlap?: number }; phashDistance: number | null; embeddingSimilarity: number | null; alternatives: number;
  post: { id: string; mediaId: string; postedAt: string; caption: string | null; permalink: string | null }; photo: PhotoCard;
}
export interface PostedCheck { kind: 'same' | 'similar' | 'none'; last: { postId: string; mediaId: string; postedAt: string; caption: string | null; permalink: string | null } | null; count: number }

export const IG_KEY = ['instagram'] as const;
export const igImage = (mediaId: string) => `/api/instagram/media/${mediaId}/image`;
export const fetchIgAccount = () => api<IgAccount>('GET', '/api/instagram/account');
export const fetchIgHistory = (filter: IgFilter, cursor?: string) => api<IgHistory>('GET', `/api/instagram/history?filter=${filter}&limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
export const fetchReview = (limit = 50) => api<{ total: number; items: ReviewItem[] }>('GET', `/api/instagram/review?limit=${limit}`);
export const decideMatch = (id: string, decision: 'confirm' | 'reject') => api('POST', `/api/instagram/matches/${id}`, { decision });
export const linkMedia = (mediaId: string, photoId: string) => api('POST', `/api/instagram/media/${mediaId}/link`, { photoId });
export const createSynthetic = (count = 40) => api<{ archive: { posts: number }; queued: boolean }>('POST', '/api/instagram/synthetic', { count });
export const syncNow = () => api<{ queued: boolean }>('POST', '/api/instagram/sync');
export const rematch = () => api<{ queued: boolean }>('POST', '/api/instagram/rematch');
export const fetchPostedCheck = (photoId: string) => api<PostedCheck>('GET', `/api/instagram/posted-check?photoId=${photoId}`);

export interface IgConnection {
  configured: boolean; mode: 'unconfigured' | 'sandbox' | 'live'; connected: boolean; warning: string | null; redirectUri: string | null; scopes?: string[]; /** false = history reading only */ publishingPermission?: boolean; missing: string[]; eligibility: string[];
  account: { username: string | null; type: string | null; status: string; scopes: string[]; tokenExpiresAt: string | null; daysLeft: number | null; lastError: string | null } | null;
}
export const fetchIgConnection = () => api<IgConnection>('GET', '/api/instagram/connection');
export const startIgConnect = () => api<{ url: string }>('POST', '/api/instagram/connect');
export const disconnectIg = () => api<{ disconnected: boolean }>('POST', '/api/instagram/disconnect');
