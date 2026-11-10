import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { open, seal } from '../auth/crypto.js';
import { withUser } from '../db/connect.js';

/**
 * Connecting an Instagram professional account with the official "Instagram API with Instagram Login" (OAuth 2.0 authorisation-code flow):
 *   1. the owner is sent to Instagram's authorise page (scopes: read profile + media, and content publishing);
 *   2. Instagram redirects back with a one-time `code` and our signed `state`;
 *   3. the code is exchanged for a short-lived token, then for a long-lived token (~60 days);
 *   4. the long-lived token is sealed with AES-256-GCM (key only in your environment configuration) and stored; it can be read only by the worker role;
 *   5. it is refreshed before it expires, and the System page warns when it is close.
 * Everything is gated: with no Meta app configured the connection reports exactly what is missing; against any non-loopback endpoint nothing is sent
 * unless `live` is explicitly true (the owner's approval, D9/D13). The access token is never logged, never returned by the API, never put in a URL we log.
 * These endpoint paths follow Meta's published documentation as understood on 2026-10-07 and MUST be re-verified against the live docs, and the whole
 * flow against a real authorised account, before the connection is called operational (docs/INSTAGRAM_READINESS.md).
 */
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'] as const;
/** What is asked for unless the owner widens it: reading the profile and the media history only. Publishing is a separate, later decision (PHOTOVAULT_IG_SCOPES). */
export const IG_DEFAULT_SCOPES = ['instagram_business_basic'] as const;
export const PUBLISH_SCOPE = 'instagram_business_content_publish';
export const IG_REAL = { authorize: 'https://www.instagram.com/oauth/authorize', token: 'https://api.instagram.com/oauth/access_token', graph: 'https://graph.instagram.com' } as const;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopbackUrl = (u: string): boolean => { try { return LOOPBACK.has(new URL(u).hostname.replace(/^\[|\]$/g, '')); } catch { return false; } };

export interface IgOAuthConfig {
  appId: string; appSecret: () => string; redirectUri: string; scopes?: readonly string[];
  authorizeUrl?: string; tokenUrl?: string; graphBase?: string;
  /** must be true to talk to anything that is not on this computer */
  live?: boolean; fetch?: typeof fetch; now?: () => number;
}
export class IgOAuthError extends Error { constructor(public readonly code: 'not_configured' | 'bad_state' | 'denied' | 'exchange_failed' | 'ineligible' | 'unavailable' | 'expired', message: string) { super(message); } }

export interface ConnectionStatus {
  configured: boolean; mode: 'unconfigured' | 'sandbox' | 'live'; connected: boolean;
  account: { id: string; username: string | null; type: string | null; status: string; scopes: string[]; tokenExpiresAt: string | null; daysLeft: number | null; lastError: string | null; synthetic: boolean } | null;
  warning: string | null; redirectUri: string | null; scopes: readonly string[]; /** false until publishing is deliberately enabled: history reading only */ publishingPermission: boolean; missing: string[]; eligibility: string[];
}
const ELIGIBILITY_BASE = [
  'A professional Instagram account (Business or Creator). Personal accounts cannot use the API.',
  'A Meta developer app with the “Instagram API with Instagram Login” product; while the app is in development mode only accounts you add as testers/admins can connect (no App Review needed for your own account).',
  'The redirect URI registered in the Meta app must be exactly the one shown here, and it must be HTTPS (a TLS reverse proxy or tunnel you set up yourself).',
  'To publish, Meta fetches the photograph from a public HTTPS address at publish time; this app only exposes a short-lived, metadata-free copy for that moment (see MEDIA_DELIVERY.md). That needs a public delivery host, which is not configured.',
  'API limits: a rolling 24-hour publishing quota (read from the API before each post), JPEG only, aspect ratio about 4:5 to 1.91:1, and long-lived tokens that last about 60 days and must be refreshed.',
];
/** The eligibility notes for a given set of requested permissions (history-only by default: the consent screen then asks for reading only). */
export const eligibilityFor = (scopes: readonly string[]): string[] => [
  ELIGIBILITY_BASE[0]!, ELIGIBILITY_BASE[1]!,
  `Permissions requested: ${scopes.join(', ')}. ${scopes.includes(PUBLISH_SCOPE) ? 'This includes publishing.' : 'This is READ-ONLY (profile and media history); publishing is not enabled and cannot be used.'}`,
  ...ELIGIBILITY_BASE.slice(2),
];
export const ELIGIBILITY = eligibilityFor(IG_SCOPES);

export class InstagramConnection {
  private readonly pending = new Map<string, number>();                           // nonce → expiry (single use; a restart cancels pending connects)
  constructor(private readonly d: { sql: Sql; cfg: IgOAuthConfig | null; atRestKey: Buffer; stateKey: Buffer }) {}
  private get cfg(): IgOAuthConfig { if (!this.d.cfg) throw new IgOAuthError('not_configured', 'No Meta app is configured.'); return this.d.cfg; }
  private now() { return (this.d.cfg?.now ?? Date.now)(); }
  private f() { return this.d.cfg?.fetch ?? fetch; }
  private urls() {
    const c = this.cfg; const authorize = c.authorizeUrl ?? IG_REAL.authorize, token = c.tokenUrl ?? IG_REAL.token, graph = (c.graphBase ?? IG_REAL.graph).replace(/\/+$/, '');
    if (![authorize, token, graph].every(isLoopbackUrl) && c.live !== true) throw new IgOAuthError('unavailable', 'Connecting to the real Instagram is disabled until you approve it (D9/D13).');
    return { authorize, token, graph };
  }
  mode(): ConnectionStatus['mode'] { if (!this.d.cfg) return 'unconfigured'; const c = this.d.cfg; return [c.authorizeUrl ?? IG_REAL.authorize, c.tokenUrl ?? IG_REAL.token, c.graphBase ?? IG_REAL.graph].every(isLoopbackUrl) ? 'sandbox' : c.live === true ? 'live' : 'unconfigured'; }

  private sign(payload: string): string { return createHmac('sha256', this.d.stateKey).update(`ig-oauth:${payload}`).digest('base64url'); }
  /** state = userId.nonce.expiry.signature — bound to the signed-in person, one use, ten minutes. */
  private makeState(userId: string): string {
    const nonce = randomBytes(16).toString('base64url'); const exp = this.now() + 10 * 60_000; this.pending.set(nonce, exp);
    for (const [k, e] of this.pending) if (e < this.now()) this.pending.delete(k);
    const p = `${userId}.${nonce}.${exp}`; return `${p}.${this.sign(p)}`;
  }
  private checkState(userId: string, state: string): void {
    const parts = state.split('.'); if (parts.length !== 4) throw new IgOAuthError('bad_state', 'The connection request is not valid.');
    const [u, nonce, exp, sig] = parts as [string, string, string, string]; const p = `${u}.${nonce}.${exp}`; const want = this.sign(p);
    const ok = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    const live = this.pending.get(nonce); this.pending.delete(nonce);              // consumed whatever happens next
    if (!ok || u !== userId || live === undefined || live < this.now() || Number(exp) < this.now()) throw new IgOAuthError('bad_state', 'The connection request expired or was not started here. Start again from Settings.');
  }

  /** The Instagram authorise URL for this person. */
  begin(userId: string): { url: string } {
    const c = this.cfg; const u = this.urls();
    const q = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirectUri, response_type: 'code', scope: (c.scopes ?? IG_DEFAULT_SCOPES).join(','), state: this.makeState(userId) });
    return { url: `${u.authorize}?${q.toString()}` };
  }

  private async json(res: Response): Promise<Record<string, unknown>> { try { return (await res.json()) as Record<string, unknown>; } catch { return {}; } }
  /** Finishes the connection after Instagram redirected back. Never returns or logs a token. */
  async complete(userId: string, p: { code?: string; state?: string; error?: string }): Promise<{ username: string | null; type: string | null; expiresAt: string }> {
    if (p.error) { if (p.state) { try { this.checkState(userId, p.state); } catch { /* ignore */ } } throw new IgOAuthError('denied', 'Instagram did not grant access.'); }
    if (!p.code || !p.state) throw new IgOAuthError('bad_state', 'The connection request is not valid.');
    this.checkState(userId, p.state);
    const c = this.cfg; const u = this.urls(); const f = this.f();
    // 1) code → short-lived token (POST, form-encoded; the secret travels only in this body)
    const short = await f(u.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.appId, client_secret: c.appSecret(), grant_type: 'authorization_code', redirect_uri: c.redirectUri, code: p.code }), redirect: 'error' }).catch(() => null);
    const sj = short ? await this.json(short) : {}; if (!short || !short.ok || typeof sj.access_token !== 'string') throw new IgOAuthError('exchange_failed', 'Instagram did not accept the authorisation code.');
    // 2) short-lived → long-lived (Meta's endpoint takes these two values as query parameters; the URL is never logged)
    const long = await f(`${u.graph}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: c.appSecret(), access_token: sj.access_token })}`, { redirect: 'error' }).catch(() => null);
    const lj = long ? await this.json(long) : {}; if (!long || !long.ok || typeof lj.access_token !== 'string' || typeof lj.expires_in !== 'number') throw new IgOAuthError('exchange_failed', 'Instagram did not issue a long-lived token.');
    const token = lj.access_token; const expiresAt = new Date(this.now() + lj.expires_in * 1000);
    // 3) who is this? (token in the Authorization header)
    const me = await f(`${u.graph}/me?fields=user_id,username,account_type`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error' }).catch(() => null);
    const mj = me ? await this.json(me) : {}; const igId = typeof mj.user_id === 'string' || typeof mj.user_id === 'number' ? String(mj.user_id) : typeof sj.user_id === 'string' || typeof sj.user_id === 'number' ? String(sj.user_id) : null;
    if (!me || !me.ok || !igId) throw new IgOAuthError('exchange_failed', 'Instagram did not return the account details.');
    const type = typeof mj.account_type === 'string' ? mj.account_type : null; const username = typeof mj.username === 'string' ? mj.username.slice(0, 100) : null;
    if (type === 'PERSONAL') throw new IgOAuthError('ineligible', 'This is a personal Instagram account. Only Business or Creator accounts can use the API; switch the account type in Instagram first.');
    const granted = Array.isArray(sj.permissions) ? (sj.permissions as unknown[]).map(String) : typeof sj.permissions === 'string' ? sj.permissions.split(',') : [...(c.scopes ?? IG_DEFAULT_SCOPES)];
    const sealed = seal(this.d.atRestKey, token, `ig-token:${userId}:${igId}`);
    await withUser(this.d.sql, userId, async (tx) => {
      // the API role may write the token columns but never read them back, so an upsert that reads EXCLUDED values is not allowed: update first, insert if there was nothing to update
      const upd = await tx`UPDATE social_accounts SET username = ${username}, account_type = ${type}, token_ciphertext = ${sealed}, token_key_id = 'v1', token_expires_at = ${expiresAt}, scopes = ${granted}::text[], status = 'CONNECTED', last_error = NULL
                            WHERE platform = 'instagram' AND external_id = ${igId} RETURNING 1`;
      if (upd.length === 0) await tx`INSERT INTO social_accounts (user_id, platform, external_id, username, account_type, token_ciphertext, token_key_id, token_expires_at, scopes, status, last_error)
                                     VALUES (${userId}, 'instagram', ${igId}, ${username}, ${type}, ${sealed}, 'v1', ${expiresAt}, ${granted}::text[], 'CONNECTED', NULL)`;
    });
    return { username, type, expiresAt: expiresAt.toISOString() };
  }

  async disconnect(userId: string): Promise<boolean> {
    return withUser(this.d.sql, userId, async (tx) => {
      const r = await tx`UPDATE social_accounts SET status = 'DISCONNECTED', token_ciphertext = NULL, token_key_id = NULL, token_expires_at = NULL, last_error = NULL WHERE platform = 'instagram' AND external_id NOT LIKE 'synthetic-%' RETURNING 1`;
      return r.length > 0;
    });
  }

  async status(userId: string): Promise<ConnectionStatus> {
    const mode = this.mode(); const missing: string[] = [];
    if (!this.d.cfg) missing.push('Meta app ID and secret (environment variables PHOTOVAULT_IG_APP_ID and PHOTOVAULT_IG_APP_SECRET)', 'the redirect URI set in the app (PHOTOVAULT_IG_REDIRECT_URI)', 'your approval to connect a real account');
    else if (mode === 'unconfigured') missing.push('your approval to connect to the real Instagram (PHOTOVAULT_IG_LIVE)');
    const a = await withUser(this.d.sql, userId, async (tx) => (await tx<{ id: string; username: string | null; account_type: string | null; status: string; scopes: string[]; token_expires_at: Date | null; last_error: string | null; external_id: string }[]>`
      SELECT id, username, account_type, status, scopes, token_expires_at, last_error, external_id FROM social_accounts WHERE platform = 'instagram' AND external_id NOT LIKE 'synthetic-%' ORDER BY (status = 'CONNECTED') DESC, created_at LIMIT 1`)[0] ?? null);
    const daysLeft = a?.token_expires_at ? Math.floor((a.token_expires_at.getTime() - this.now()) / 86_400_000) : null;
    const warning = !a ? null : a.status === 'EXPIRED' ? 'The Instagram token has expired or was revoked. Connect again.' : a.status === 'CONNECTED' && daysLeft !== null && daysLeft <= 14 ? `The Instagram token expires in ${Math.max(0, daysLeft)} day${daysLeft === 1 ? '' : 's'}; it is refreshed automatically while the worker runs.` : null;
    return {
      configured: !!this.d.cfg && mode !== 'unconfigured', mode, connected: a?.status === 'CONNECTED',
      account: a ? { id: a.id, username: a.username, type: a.account_type, status: a.status, scopes: a.scopes, tokenExpiresAt: a.token_expires_at?.toISOString() ?? null, daysLeft, lastError: a.last_error, synthetic: false } : null,
      warning, redirectUri: this.d.cfg?.redirectUri ?? null, scopes: this.d.cfg?.scopes ?? IG_DEFAULT_SCOPES, publishingPermission: (this.d.cfg?.scopes ?? IG_DEFAULT_SCOPES).includes(PUBLISH_SCOPE), missing, eligibility: eligibilityFor(this.d.cfg?.scopes ?? IG_DEFAULT_SCOPES),
    };
  }
}

// ------------------------------------------------------------------------------------------------ worker side (service role)
/** Reads and renews sealed tokens. Only the worker/publisher roles can select the token columns. */
export class TokenVault {
  constructor(private readonly d: { sql: Sql; atRestKey: Buffer; cfg: IgOAuthConfig | null }) {}
  async read(accountId: string, userId: string): Promise<{ token: string; igUserId: string; expiresAt: Date | null } | null> {
    const [a] = await this.d.sql<{ external_id: string; token_ciphertext: Buffer | null; token_expires_at: Date | null; status: string }[]>`SELECT external_id, token_ciphertext, token_expires_at, status FROM social_accounts WHERE id = ${accountId}::uuid AND user_id = ${userId}`;
    if (!a || a.status !== 'CONNECTED' || !a.token_ciphertext) return null;
    return { token: open(this.d.atRestKey, a.token_ciphertext, `ig-token:${userId}:${a.external_id}`), igUserId: a.external_id, expiresAt: a.token_expires_at };
  }
  /** Renews every connected token that expires within `withinDays`. A token Instagram refuses is marked EXPIRED (the owner must connect again). */
  async refreshDue(withinDays = 20, now: () => number = Date.now): Promise<{ refreshed: number; expired: number; skipped: number }> {
    const c = this.d.cfg; if (!c) return { refreshed: 0, expired: 0, skipped: 0 };
    const graph = (c.graphBase ?? IG_REAL.graph).replace(/\/+$/, ''); if (!isLoopbackUrl(graph) && c.live !== true) return { refreshed: 0, expired: 0, skipped: 0 };
    const rows = await this.d.sql<{ id: string; user_id: string; external_id: string; token_ciphertext: Buffer; token_expires_at: Date | null }[]>`
      SELECT id, user_id, external_id, token_ciphertext, token_expires_at FROM social_accounts WHERE platform = 'instagram' AND status = 'CONNECTED' AND token_ciphertext IS NOT NULL AND external_id NOT LIKE 'synthetic-%'
         AND (token_expires_at IS NULL OR token_expires_at < ${new Date(now() + withinDays * 86_400_000)})`;
    const out = { refreshed: 0, expired: 0, skipped: 0 }; const f = c.fetch ?? fetch;
    for (const r of rows) {
      const aad = `ig-token:${r.user_id}:${r.external_id}`; let token: string; try { token = open(this.d.atRestKey, r.token_ciphertext, aad); } catch { out.skipped++; continue; }
      const res = await f(`${graph}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`, { redirect: 'error' }).catch(() => null);
      if (!res) { out.skipped++; continue; }                                                                    // network trouble: try again on the next run
      const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { code?: number } };
      if (res.ok && typeof j.access_token === 'string' && typeof j.expires_in === 'number') {
        await this.d.sql`UPDATE social_accounts SET token_ciphertext = ${seal(this.d.atRestKey, j.access_token, aad)}, token_expires_at = ${new Date(now() + j.expires_in * 1000)}, last_error = NULL WHERE id = ${r.id}::uuid`; out.refreshed++;
      } else if (res.status === 401 || j.error?.code === 190) {          // Instagram says the token is invalid, expired or revoked: only the owner can fix that
        await this.d.sql`UPDATE social_accounts SET status = 'EXPIRED', last_error = 'Instagram refused to renew the token; connect the account again.' WHERE id = ${r.id}::uuid`; out.expired++;
      } else out.skipped++;                                                // anything else (for example “token not yet 24 hours old”, a rate limit): leave it and try again later
    }
    return out;
  }
}
