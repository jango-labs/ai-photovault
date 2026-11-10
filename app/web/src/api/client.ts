export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => { csrfToken = t; };

/** Same-origin JSON client. Sends the CSRF header on every state-changing call; cookies carry the session (HttpOnly, never visible to JS). */
export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and that the AI PhotoVault server is running.');
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? 'Something went wrong.'), typeof json.retryAfter === 'number' ? json.retryAfter : undefined);
  return json as T;
}

export interface Me { id: string; email: string; displayName: string | null; timezone: string; totpEnabled: boolean }
export interface Settings { viewerSurface: 'neutral' | 'teal'; thumbSize: number; aiScoresVisible: boolean }
export interface SessionInfo { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; ip: string | null; userAgent: string | null; current: boolean }
export interface MeResponse { user: Me; settings: Settings; csrfToken: string }
export interface SystemStatus { api: { ok: boolean; version: string; uptimeSeconds: number; node: string }; database: { ok: boolean; latencyMs: number; version?: string }; time: string }

export async function fetchMe(): Promise<MeResponse | null> {
  try {
    const me = await api<MeResponse>('GET', '/api/auth/me');
    setCsrfToken(me.csrfToken);
    return me;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setCsrfToken(null); return null; }
    throw e;
  }
}

/** "Safari on macOS" from a User-Agent string (best effort, display only). */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /vitest|curl|node/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
