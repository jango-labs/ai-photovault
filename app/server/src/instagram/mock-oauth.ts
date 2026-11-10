import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

/**
 * A local stand-in for Instagram's OAuth + Graph endpoints (sandbox). It enforces what the real service enforces — one-use authorisation codes bound to the
 * redirect URI, the app secret, the 24-hour minimum token age before a refresh, bearer tokens, paging — so the connection, refresh, history-sync and expiry
 * code can be tested without any real account. It is NOT Instagram: nothing proves the real service behaves the same until a real, authorised account is tried.
 */
export interface MockPost { id: string; caption: string; timestamp: string; permalink?: string; colour?: { r: number; g: number; b: number }; width?: number; height?: number }
export class MockInstagramOAuth {
  private server: http.Server | null = null;
  readonly codes = new Map<string, { redirectUri: string; used: boolean }>();
  readonly tokens = new Map<string, { kind: 'short' | 'long'; issuedAt: number; expiresAt: number; revoked: boolean }>();
  readonly calls: Array<{ method: string; path: string }> = [];
  posts: MockPost[] = [];
  constructor(readonly o: { appId: string; appSecret: string; userId?: string; username?: string; accountType?: 'BUSINESS' | 'MEDIA_CREATOR' | 'PERSONAL'; longLivedSeconds?: number; now?: () => number } = { appId: 'app', appSecret: 'secret' }) {}
  private now() { return (this.o.now ?? Date.now)(); }
  get base(): string { return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`; }
  get authorizeUrl() { return `${this.base}/oauth/authorize`; }
  get tokenUrl() { return `${this.base}/oauth/access_token`; }
  get graphBase() { return `${this.base}/v1`; }
  async start() { this.server = http.createServer((q, r) => void this.handle(q, r)); await new Promise<void>((res) => this.server!.listen(0, '127.0.0.1', res)); }
  async stop() { await new Promise<void>((res) => { this.server?.closeAllConnections?.(); if (this.server) this.server.close(() => res()); else res(); }); this.server = null; }
  revokeAll() { for (const t of this.tokens.values()) t.revoked = true; }
  private json(res: http.ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  private err(res: http.ServerResponse, status: number, code: number, message = 'error') { this.json(res, status, { error: { code, message } }); }
  private bearer(req: http.IncomingMessage, url: URL): string | null { const h = req.headers.authorization; if (h?.startsWith('Bearer ')) return h.slice(7); return url.searchParams.get('access_token'); }
  private valid(tok: string | null, kind?: 'short' | 'long') { const t = tok ? this.tokens.get(tok) : undefined; return t && !t.revoked && t.expiresAt > this.now() && (!kind || t.kind === kind) ? t : null; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.base); const p = url.pathname; this.calls.push({ method: req.method ?? 'GET', path: p });
    // the owner clicking “Allow”: redirect back with a one-use code and the state we were given
    if (req.method === 'GET' && p === '/oauth/authorize') {
      const q = url.searchParams; if (q.get('client_id') !== this.o.appId || q.get('response_type') !== 'code' || !q.get('redirect_uri') || !q.get('state')) return this.err(res, 400, 100, 'Invalid request');
      const code = randomBytes(12).toString('hex'); this.codes.set(code, { redirectUri: q.get('redirect_uri')!, used: false });
      const to = new URL(q.get('redirect_uri')!); to.searchParams.set('code', code); to.searchParams.set('state', q.get('state')!); res.writeHead(302, { location: to.toString() }); return res.end();
    }
    if (req.method === 'POST' && p === '/oauth/access_token') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const f = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const c = this.codes.get(f.get('code') ?? '');
      if (f.get('client_id') !== this.o.appId || f.get('client_secret') !== this.o.appSecret || f.get('grant_type') !== 'authorization_code' || !c || c.used || c.redirectUri !== f.get('redirect_uri')) return this.err(res, 400, 100, 'Invalid authorization code');
      c.used = true; const tok = `short_${randomBytes(10).toString('hex')}`; this.tokens.set(tok, { kind: 'short', issuedAt: this.now(), expiresAt: this.now() + 3600_000, revoked: false });
      return this.json(res, 200, { access_token: tok, user_id: Number(this.o.userId ?? '17841400000000000'), permissions: ['instagram_business_basic', 'instagram_business_content_publish'] });
    }
    if (req.method === 'GET' && p === '/v1/access_token') {
      const t = this.valid(url.searchParams.get('access_token'), 'short');
      if (url.searchParams.get('grant_type') !== 'ig_exchange_token' || url.searchParams.get('client_secret') !== this.o.appSecret || !t) return this.err(res, 400, 190, 'Invalid token');
      const tok = `long_${randomBytes(10).toString('hex')}`; const ttl = (this.o.longLivedSeconds ?? 5_184_000) * 1000; this.tokens.set(tok, { kind: 'long', issuedAt: this.now(), expiresAt: this.now() + ttl, revoked: false });
      return this.json(res, 200, { access_token: tok, token_type: 'bearer', expires_in: ttl / 1000 });
    }
    if (req.method === 'GET' && p === '/v1/refresh_access_token') {
      const old = url.searchParams.get('access_token'); const t = this.valid(old, 'long');
      if (url.searchParams.get('grant_type') !== 'ig_refresh_token' || !t) return this.err(res, 400, 190, 'Invalid token');
      if (this.now() - t.issuedAt < 24 * 3600_000) return this.err(res, 400, 10, 'Token must be at least 24 hours old');      // the real service has the same rule
      const tok = `long_${randomBytes(10).toString('hex')}`; const ttl = (this.o.longLivedSeconds ?? 5_184_000) * 1000; this.tokens.set(tok, { kind: 'long', issuedAt: this.now(), expiresAt: this.now() + ttl, revoked: false });
      return this.json(res, 200, { access_token: tok, token_type: 'bearer', expires_in: ttl / 1000 });
    }
    // Graph reads need a valid long-lived bearer token
    const bearer = this.valid(this.bearer(req, url), 'long');
    if (p.startsWith('/v1/') && !bearer) return this.err(res, 401, 190, 'Invalid OAuth access token.');
    if (req.method === 'GET' && p === '/v1/me') return this.json(res, 200, { user_id: this.o.userId ?? '17841400000000000', username: this.o.username ?? 'sandbox_photographer', account_type: this.o.accountType ?? 'BUSINESS' });
    const media = new RegExp(`^/v1/${this.o.userId ?? '17841400000000000'}/media$`).exec(p);
    if (req.method === 'GET' && media) {
      const sorted = [...this.posts].sort((a, b) => b.timestamp.localeCompare(a.timestamp)); const after = Number(url.searchParams.get('after') ?? 0); const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), 25);
      const page = sorted.slice(after, after + limit);
      return this.json(res, 200, { data: page.map((x) => ({ id: x.id, caption: x.caption, media_type: 'IMAGE', permalink: x.permalink ?? `https://www.instagram.com/p/${x.id}/`, timestamp: x.timestamp, media_url: `${this.base}/img/${x.id}.jpg` })),
        paging: after + limit < sorted.length ? { cursors: { after: String(after + limit) }, next: `${this.graphBase}/media?after=${after + limit}` } : { cursors: {} } });
    }
    const img = /^\/img\/([A-Za-z0-9_-]+)\.jpg$/.exec(p);
    if (req.method === 'GET' && img) {
      const x = this.posts.find((m) => m.id === img[1]); if (!x) return this.err(res, 404, 100);
      const buf = await sharp({ create: { width: x.width ?? 600, height: x.height ?? 600, channels: 3, background: x.colour ?? { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer(); res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(buf);
    }
    this.err(res, 404, 100, 'Unknown path');
  }
  /** What the browser does after the owner clicks “Allow”: returns the redirect target (with code and state) without following it. */
  async consent(authorizeUrl: string): Promise<URL> { const r = await fetch(authorizeUrl, { redirect: 'manual' }); const loc = r.headers.get('location'); if (!loc) throw new Error(`no redirect (${r.status})`); return new URL(loc); }
}
