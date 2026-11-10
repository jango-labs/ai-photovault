import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

/**
 * Instagram content publishing, as the app needs it: create a container from a public image URL, wait for it, publish it, read it back,
 * and list recent media (to reconcile an ambiguous outcome). `HttpGraphPublisher` speaks the official protocol over HTTP; in this build it can
 * only be pointed at a loopback server — the MockGraphServer below. A real Instagram base URL is refused unless an explicit `live` flag is passed,
 * which nothing in the app does (owner approval D9/D13 first). The access token is sent only in an `Authorization` header.
 */
export interface GraphMedia { id: string; permalink: string | null; timestamp: string; caption: string }
export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED';
export interface GraphPublisher {
  createContainer(req: { imageUrl: string; caption: string; clientKey: string }): Promise<{ id: string }>;
  containerStatus(id: string): Promise<{ status: ContainerStatus; error: string | null }>;
  /** throws UnknownOutcome when the request may or may not have taken effect */
  publish(containerId: string): Promise<{ mediaId: string }>;
  getMedia(id: string): Promise<GraphMedia | null>;
  recentMedia(limit?: number): Promise<GraphMedia[]>;
}
export class TransientGraphError extends Error { constructor(msg: string, public readonly retryAfterSeconds?: number) { super(msg); } }
export class PermanentGraphError extends Error { constructor(msg: string, public readonly code?: number) { super(msg); } }
export class AuthExpired extends Error { constructor() { super('The Instagram access token has expired or was revoked.'); } }
export class AlreadyPublished extends Error { constructor() { super('Instagram reports that this container was already published.'); } }
export class UnknownOutcome extends Error { constructor(msg = 'The publish request got no clear answer; the post may or may not exist.') { super(msg); } }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export interface HttpGraphOptions { baseUrl: string; igUserId: string; token: () => string; timeoutMs?: number; live?: boolean }
export class HttpGraphPublisher implements GraphPublisher {
  private readonly base: string;
  constructor(private readonly o: HttpGraphOptions) {
    const u = new URL(o.baseUrl);
    if (!LOOPBACK.has(u.hostname) && o.live !== true) throw new PermanentGraphError('Publishing to a real Instagram endpoint is disabled in this build.');
    this.base = o.baseUrl.replace(/\/+$/, '');
  }
  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, string>, ambiguous = false): Promise<unknown> {
    const url = `${this.base}${path}`; const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetch(url, { method, signal: ctl.signal, headers: { authorization: `Bearer ${this.o.token()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw ambiguous ? new UnknownOutcome() : new TransientGraphError('Instagram could not be reached.'); } finally { clearTimeout(t); }
    let json: { error?: { code?: number } } & Record<string, unknown> = {};
    try { json = (await res.json()) as typeof json; } catch { /* not JSON */ }
    if (res.ok) return json;
    const code = json.error?.code;
    if (code === 190 || res.status === 401) throw new AuthExpired();
    if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) throw new TransientGraphError('Instagram asked us to slow down.', Number(res.headers.get('retry-after') ?? 300));
    if (code === 2207051) throw new AlreadyPublished();
    if (res.status >= 500) throw ambiguous ? new UnknownOutcome() : new TransientGraphError(`Instagram had a problem (${res.status}).`);
    throw new PermanentGraphError(`Instagram rejected the request (code ${code ?? res.status}).`, code);                 // its message text is not repeated
  }
  async createContainer(r: { imageUrl: string; caption: string; clientKey: string }) { const j = (await this.call('POST', `/${encodeURIComponent(this.o.igUserId)}/media`, { image_url: r.imageUrl, caption: r.caption, client_key: r.clientKey })) as { id: string }; return { id: String(j.id) }; }
  async containerStatus(id: string) { const j = (await this.call('GET', `/${encodeURIComponent(id)}?fields=status_code,status`)) as { status_code?: string; status?: string }; return { status: (j.status_code ?? 'IN_PROGRESS') as ContainerStatus, error: j.status_code === 'ERROR' ? (j.status ?? 'The image was rejected.') : null }; }
  async publish(containerId: string) { const j = (await this.call('POST', `/${encodeURIComponent(this.o.igUserId)}/media_publish`, { creation_id: containerId }, true)) as { id: string }; return { mediaId: String(j.id) }; }
  async getMedia(id: string): Promise<GraphMedia | null> {
    try { const j = (await this.call('GET', `/${encodeURIComponent(id)}?fields=id,permalink,timestamp,caption`)) as { id: string; permalink?: string; timestamp: string; caption?: string }; return { id: j.id, permalink: j.permalink ?? null, timestamp: new Date(j.timestamp).toISOString(), caption: j.caption ?? '' }; }
    catch (e) { if (e instanceof PermanentGraphError && (e.code === 100 || e.code === 803)) return null; throw e; }
  }
  async recentMedia(limit = 25): Promise<GraphMedia[]> {
    const j = (await this.call('GET', `/${encodeURIComponent(this.o.igUserId)}/media?fields=id,permalink,timestamp,caption&limit=${limit}`)) as { data: Array<{ id: string; permalink?: string; timestamp: string; caption?: string }> };
    return j.data.map((x) => ({ id: x.id, permalink: x.permalink ?? null, timestamp: new Date(x.timestamp).toISOString(), caption: x.caption ?? '' }));
  }
}

// ---------------------------------------------------------------- the mock Graph server (local, for development and tests)
export type Fault = 'http500' | 'rate_limit' | 'auth' | 'drop_after_effect' | 'drop_no_effect' | 'container_error';
export class MockGraphServer {
  private server: http.Server | null = null;
  readonly containers = new Map<string, { id: string; caption: string; imageUrl: string; clientKey: string; polls: number; status: ContainerStatus; error: string | null; mediaId: string | null }>();
  readonly media: Array<GraphMedia & { imageBytes: number; imageInfo: { format?: string; width?: number; height?: number; hasExif: boolean } }> = [];
  readonly calls: Array<{ method: string; path: string }> = [];
  publishCalls = 0;
  private readonly faults = new Map<string, Fault[]>();
  constructor(readonly o: { token: string; igUserId: string; pollsToFinish?: number; now?: () => Date } = { token: 'mock-token', igUserId: 'ig-mock' }) {}
  failNext(endpoint: 'create' | 'status' | 'publish' | 'media' | 'list', fault: Fault, times = 1) { const q = this.faults.get(endpoint) ?? []; for (let i = 0; i < times; i++) q.push(fault); this.faults.set(endpoint, q); }
  private take(endpoint: string): Fault | undefined { return this.faults.get(endpoint)?.shift(); }
  get baseUrl(): string { return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`; }
  async start(): Promise<void> { this.server = http.createServer((req, res) => void this.handle(req, res)); await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r)); }
  async stop(): Promise<void> { await new Promise<void>((r) => { this.server?.closeAllConnections?.(); if (this.server) this.server.close(() => r()); else r(); }); this.server = null; }
  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); }
  private err(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) { this.json(res, status, { error: { code, message, type: 'OAuthException' } }, headers); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname.replace(/^\/v1/, ''); this.calls.push({ method: req.method ?? 'GET', path });
    if (req.headers.authorization !== `Bearer ${this.o.token}`) return this.err(res, 400, 190, 'Invalid OAuth access token.');
    let body: Record<string, string> = {}; if (req.method === 'POST') { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return this.err(res, 400, 100, 'bad json'); } }
    const ig = `/${this.o.igUserId}`; const now = (this.o.now ?? (() => new Date()))();
    const fault = (ep: string): Fault | undefined => { const f = this.take(ep); if (f === 'http500') { this.err(res, 500, 2, 'Internal error'); return f; } if (f === 'rate_limit') { this.err(res, 400, 4, 'Rate limit', { 'retry-after': '120' }); return f; } if (f === 'auth') { this.err(res, 400, 190, 'Expired token'); return f; } if (f === 'drop_no_effect') { req.socket.destroy(); return f; } return f; };

    if (req.method === 'POST' && path === `${ig}/media`) {
      const f = fault('create'); if (f && f !== 'container_error') return;
      const key = String(body.client_key ?? ''); const existing = [...this.containers.values()].find((c) => key && c.clientKey === key);
      if (existing) return this.json(res, 200, { id: existing.id });                                  // the mock honours the client key; the real API does not (the app never relies on that)
      const id = `c_${randomUUID().slice(0, 8)}`; this.containers.set(id, { id, caption: String(body.caption ?? ''), imageUrl: String(body.image_url ?? ''), clientKey: key, polls: 0, status: 'IN_PROGRESS', error: f === 'container_error' ? 'The image could not be processed.' : null, mediaId: null });
      return this.json(res, 200, { id });
    }
    const cm = /^\/(c_[0-9a-f]+)$/.exec(path);
    if (req.method === 'GET' && cm) {
      const f = fault('status'); if (f) return;
      const c = this.containers.get(cm[1]!); if (!c) return this.err(res, 400, 100, 'Unsupported get request');
      c.polls++;
      if (c.error) c.status = 'ERROR'; else if (c.polls > (this.o.pollsToFinish ?? 1)) { c.status = (await this.checkImage(c)) ?? 'FINISHED'; if (c.status === 'ERROR') c.error = 'The image was rejected (format, size or aspect ratio).'; }
      return this.json(res, 200, { id: c.id, status_code: c.status, status: c.error ?? undefined });
    }
    if (req.method === 'POST' && path === `${ig}/media_publish`) {
      this.publishCalls++;
      const f = fault('publish'); if (f && f !== 'drop_after_effect') return;
      const c = this.containers.get(String(body.creation_id ?? '')); if (!c) return this.err(res, 400, 100, 'Invalid creation id');
      if (c.status !== 'FINISHED') return this.err(res, 400, 9007, 'The media is not ready to be published.');
      if (c.mediaId) return this.err(res, 400, 2207051, 'Already published');
      const mid = `m_${randomUUID().slice(0, 8)}`; c.mediaId = mid;
      const info = await this.imageInfo(c.imageUrl);
      this.media.unshift({ id: mid, permalink: `https://mock.instagram.invalid/p/${mid}/`, timestamp: now.toISOString(), caption: c.caption, imageBytes: info.bytes, imageInfo: info.info });
      if (f === 'drop_after_effect') { req.socket.destroy(); return; }
      return this.json(res, 200, { id: mid });
    }
    const mm = /^\/(m_[0-9a-f]+)$/.exec(path);
    if (req.method === 'GET' && mm) { const f = fault('media'); if (f) return; const m = this.media.find((x) => x.id === mm[1]); return m ? this.json(res, 200, { id: m.id, permalink: m.permalink, timestamp: m.timestamp, caption: m.caption }) : this.err(res, 400, 100, 'Object does not exist'); }
    if (req.method === 'GET' && path === `${ig}/media`) { const f = fault('list'); if (f) return; return this.json(res, 200, { data: this.media.map((m) => ({ id: m.id, permalink: m.permalink, timestamp: m.timestamp, caption: m.caption })).slice(0, Number(url.searchParams.get('limit') ?? 25)) }); }
    this.err(res, 404, 100, 'Unknown path');
  }

  /** What Instagram's servers would do: fetch the public URL and refuse anything that is not a reasonable JPEG. */
  private async imageInfo(imageUrl: string) {
    const r = await fetch(imageUrl).catch(() => null); if (!r || r.status !== 200) return { bytes: 0, info: { hasExif: false } };
    const buf = Buffer.from(await r.arrayBuffer()); const m = await sharp(buf).metadata().catch(() => null);
    return { bytes: buf.length, info: { ...(m?.format ? { format: m.format } : {}), ...(m?.width ? { width: m.width } : {}), ...(m?.height ? { height: m.height } : {}), hasExif: !!m?.exif } };
  }
  private async checkImage(c: { imageUrl: string }): Promise<ContainerStatus | null> {
    const { bytes, info } = await this.imageInfo(c.imageUrl);
    if (!bytes || info.format !== 'jpeg' || bytes > 8 * 1024 * 1024 || !info.width || !info.height) return 'ERROR';
    const ratio = info.width / info.height; return ratio < 0.79 || ratio > 1.92 ? 'ERROR' : null;
  }
}
