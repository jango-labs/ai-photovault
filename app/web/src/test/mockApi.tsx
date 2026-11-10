import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthProvider';
import { setCsrfToken } from '../api/client';
import { libraryRoutes } from './fakeLibrary';

export interface Call { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }
export type Reply = { status?: number; json?: unknown };
export type Routes = Record<string, Reply | ((c: Call) => Reply)>;

export const ME = { user: { id: 'u1', email: 'owner@example.test', displayName: null, timezone: 'Europe/London', totpEnabled: true }, settings: { viewerSurface: 'neutral', thumbSize: 240, aiScoresVisible: false }, csrfToken: 'csrf-token-for-tests' };
export const SESSIONS = { sessions: [
  { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-01T10:00:00Z', lastSeenAt: '2026-10-08T10:00:00Z', expiresAt: '2026-10-31T10:00:00Z', ip: '100.64.0.1', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Safari/605 Version/17', current: true },
  { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-09-20T10:00:00Z', lastSeenAt: '2026-10-05T10:00:00Z', expiresAt: '2026-10-20T10:00:00Z', ip: '100.64.0.2', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) AppleWebKit Safari/605', current: false },
] };

/** Replaces fetch with an in-memory API. Unmatched calls fail loudly so tests never silently hit the network. */
export function mockApi(routes: Routes): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = String(url).split('?')[0]!;
    const call: Call = { method, path, query: new URLSearchParams(String(url).split('?')[1] ?? ''), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const key = `${method} ${path}`;
    // keys starting with ~ are regular expressions over "METHOD /path" (for ids)
    const r = routes[key] ?? Object.entries(routes).find(([k]) => k.startsWith('~') && new RegExp(`^${k.slice(1)}$`).test(key))?.[1];
    if (!r) throw new Error(`unmocked request: ${method} ${path}`);
    const out = typeof r === 'function' ? r(call) : r;
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

/** quiet defaults for the Instagram endpoints the shell and the viewer call on every page; tests that care override them */
export const instagramDefaults = (): Routes => ({
  'GET /api/instagram/review': { json: { total: 0, items: [] } }, 'GET /api/instagram/posted-check': { json: { kind: 'none', last: null, count: 0 } },
  'GET /api/instagram/account': { json: { account: null, stats: { posts: 0, matched: 0, review: 0, unmatched: 0 }, syncing: false, lastRun: null, capabilities: { synthetic: false, live: false } } },
  'GET /api/instagram/history': { json: { items: [], nextCursor: null, counts: { all: 0, matched: 0, review: 0, unmatched: 0 } } },
});
export const signedIn = (extra: Routes = {}): Routes => ({ 'GET /api/auth/me': { json: ME }, ...libraryRoutes().routes, ...instagramDefaults(), ...extra });
export const signedOut = (extra: Routes = {}): Routes => ({ 'GET /api/auth/me': { status: 401, json: { error: 'unauthenticated', message: 'Please sign in.' } }, ...extra });

export function renderApp(path: string) {
  setCsrfToken(null);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}><AuthProvider><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></AuthProvider></QueryClientProvider>);
}
