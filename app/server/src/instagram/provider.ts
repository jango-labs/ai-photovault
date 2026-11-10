import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * The boundary to Instagram. Everything the app knows about an account's history arrives through an `InstagramProvider`:
 *  - `MockInstagramProvider` reads a local archive (a manifest plus image files) — used for the synthetic archive and tests;
 *  - `GraphInstagramProvider` is the official Instagram API client. It is NEVER constructed in this build: it needs a real account,
 *    a Meta app and an access token, which are approval items (D9/D13). It is exercised only against a fake transport in tests.
 */
export interface RemoteMedia { platformMediaId: string; mediaUrl: string | null; width?: number; height?: number }
export interface RemotePost { platformPostId: string; permalink: string | null; mediaType: 'IMAGE' | 'CAROUSEL_ALBUM' | 'VIDEO'; postedAt: string; caption: string | null; media: RemoteMedia[] }
export interface PostPage { posts: RemotePost[]; next: string | null }
export interface InstagramProvider {
  readonly kind: 'mock' | 'graph';
  listPosts(cursor: string | null): Promise<PostPage>;
  fetchMedia(media: RemoteMedia): Promise<Buffer>;
}

export class TokenExpired extends Error { constructor() { super('The Instagram access token has expired or was revoked. Reconnect the account.'); } }
export class RateLimited extends Error { constructor(public readonly retryAfterSeconds: number) { super(`Instagram asked us to slow down; retry in ${retryAfterSeconds} s.`); } }
export class ProviderError extends Error { constructor(message: string, public readonly status?: number) { super(message); } }

// ---------------------------------------------------------------- synthetic / local archive
export const ManifestSchema = z.object({
  posts: z.array(z.object({
    id: z.string().min(1).max(100), permalink: z.string().max(300).nullable().default(null), mediaType: z.enum(['IMAGE', 'CAROUSEL_ALBUM', 'VIDEO']).default('IMAGE'),
    postedAt: z.string().datetime(), caption: z.string().max(2200).nullable().default(null),
    media: z.array(z.object({ id: z.string().min(1).max(100), file: z.string().min(1).max(200), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() })).min(1).max(10),
  })).max(100_000),
}).strict();
export type Manifest = z.infer<typeof ManifestSchema>;
const PAGE = 25;

/** Files named in a manifest must stay inside the archive folder (no absolute paths, no `..`, no symlink escape). */
async function insideDir(dir: string, rel: string): Promise<string> {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new ProviderError('The archive names a file outside its folder.');
  const abs = path.resolve(dir, rel); const real = await fs.realpath(abs); const root = await fs.realpath(dir);
  if (!real.startsWith(root + path.sep)) throw new ProviderError('The archive names a file outside its folder.');
  return real;
}

export class MockInstagramProvider implements InstagramProvider {
  readonly kind = 'mock' as const;
  constructor(private readonly dir: string) {}
  private async manifest(): Promise<Manifest> {
    let raw: string; try { raw = await fs.readFile(path.join(this.dir, 'manifest.json'), 'utf8'); } catch { throw new ProviderError('The synthetic archive has not been created yet.'); }
    const r = ManifestSchema.safeParse(JSON.parse(raw)); if (!r.success) throw new ProviderError('The archive manifest is not valid.'); return r.data;
  }
  async listPosts(cursor: string | null): Promise<PostPage> {
    const m = await this.manifest(); const sorted = [...m.posts].sort((a, b) => b.postedAt.localeCompare(a.postedAt) || (a.id < b.id ? 1 : -1));    // the API returns newest first
    const start = cursor === null ? 0 : Number(cursor); if (!Number.isInteger(start) || start < 0) throw new ProviderError('Bad cursor.');
    const slice = sorted.slice(start, start + PAGE);
    return { posts: slice.map((p) => ({ platformPostId: p.id, permalink: p.permalink, mediaType: p.mediaType, postedAt: p.postedAt, caption: p.caption, media: p.media.map((x) => ({ platformMediaId: x.id, mediaUrl: `file:${x.file}`, ...(x.width ? { width: x.width } : {}), ...(x.height ? { height: x.height } : {}) })) })), next: start + PAGE < sorted.length ? String(start + PAGE) : null };
  }
  async fetchMedia(media: RemoteMedia): Promise<Buffer> {
    if (!media.mediaUrl?.startsWith('file:')) throw new ProviderError('No such media.');
    return fs.readFile(await insideDir(this.dir, media.mediaUrl.slice(5)));
  }
}

// ---------------------------------------------------------------- official Instagram API (disabled in this build)
export interface Transport { get(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; json?: unknown; body?: Buffer }> }
export const GRAPH = 'https://graph.instagram.com/v25.0';
const FIELDS = 'id,caption,media_type,permalink,timestamp,media_url,children{id,media_type,media_url}';
const GraphPage = z.object({
  data: z.array(z.object({
    id: z.string(), caption: z.string().optional(), media_type: z.string(), permalink: z.string().optional(), timestamp: z.string(), media_url: z.string().optional(),
    children: z.object({ data: z.array(z.object({ id: z.string(), media_type: z.string(), media_url: z.string().optional() })) }).optional(),
  })), paging: z.object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() }).optional(),
});
const GraphError = z.object({ error: z.object({ code: z.number().optional(), message: z.string().optional() }) });

export class GraphInstagramProvider implements InstagramProvider {
  readonly kind = 'graph' as const;
  /** `enabled` must be passed explicitly: nothing in the app does, and the owner's approval (D9/D13) comes first. */
  private readonly base: string; private readonly loopback: boolean;
  /** `baseUrl` other than the real Instagram must be on this computer (a sandbox) unless `live` is explicitly true. */
  constructor(private readonly o: { enabled: boolean; igUserId: string; token: () => string; transport: Transport; baseUrl?: string; live?: boolean }) {
    if (!o.enabled) throw new ProviderError('The Instagram connection is disabled in this build.');
    this.base = (o.baseUrl ?? GRAPH).replace(/\/+$/, ''); this.loopback = ['127.0.0.1', 'localhost', '::1'].includes(new URL(this.base).hostname.replace(/^\[|\]$/g, ''));
    if (!this.loopback && !(o.live === true && this.base.startsWith('https://'))) throw new ProviderError('Reading a real Instagram account is disabled until you approve it.');
  }
  private headers() { return { authorization: `Bearer ${this.o.token()}`, accept: 'application/json' }; }
  private fail(r: { status: number; headers: Record<string, string>; json?: unknown }): never {
    const e = GraphError.safeParse(r.json); const code = e.success ? e.data.error.code : undefined;
    if (code === 190 || r.status === 401) throw new TokenExpired();
    if (code === 4 || code === 17 || code === 32 || code === 613 || r.status === 429) throw new RateLimited(Number(r.headers['retry-after'] ?? 300));
    throw new ProviderError(`Instagram returned an error (${code ?? r.status}).`, r.status);       // the provider's message text is not repeated: it can echo request details
  }
  async listPosts(cursor: string | null): Promise<PostPage> {
    const url = `${this.base}/${encodeURIComponent(this.o.igUserId)}/media?fields=${encodeURIComponent(FIELDS)}&limit=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const r = await this.o.transport.get(url, this.headers()); if (r.status !== 200) this.fail(r);
    const p = GraphPage.safeParse(r.json); if (!p.success) throw new ProviderError('Instagram returned data in an unexpected shape.');
    return {
      posts: p.data.data.map((x): RemotePost => ({
        platformPostId: x.id, permalink: x.permalink ?? null, mediaType: x.media_type === 'CAROUSEL_ALBUM' ? 'CAROUSEL_ALBUM' : x.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGE', postedAt: new Date(x.timestamp).toISOString(), caption: x.caption ?? null,
        media: (x.children?.data.filter((c) => c.media_type === 'IMAGE') ?? [{ id: x.id, media_type: x.media_type, media_url: x.media_url }]).filter((c) => c.media_type === 'IMAGE').map((c) => ({ platformMediaId: c.id, mediaUrl: c.media_url ?? null })),
      })).filter((x) => x.media.length > 0),                                   // videos have no still to fingerprint
      next: p.data.paging?.next ? (p.data.paging.cursors?.after ?? null) : null,
    };
  }
  async fetchMedia(media: RemoteMedia): Promise<Buffer> {
    if (!(media.mediaUrl?.startsWith('https://') || (this.loopback && media.mediaUrl?.startsWith('http://127.0.0.1')))) throw new ProviderError('The post has no downloadable image.');
    const r = await this.o.transport.get(media.mediaUrl, { accept: 'image/*' });      // the CDN URL is signed; the access token is never sent to it
    if (r.status !== 200 || !r.body) throw new ProviderError(`The image could not be downloaded (${r.status}).`, r.status);
    return r.body;
  }
}

/** The real HTTP transport (timeouts, no redirects, bodies capped at 20 MB). It carries no credentials of its own: the provider passes them in headers. */
export function fetchTransport(timeoutMs = 20_000): Transport {
  return {
    async get(url, headers) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'error' });
        const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 20 * 1024 * 1024) throw new ProviderError('The response was too large.');
        const h: Record<string, string> = {}; res.headers.forEach((v, k) => { h[k] = v; });
        if ((h['content-type'] ?? '').includes('json')) { try { return { status: res.status, headers: h, json: JSON.parse(buf.toString('utf8')) }; } catch { return { status: res.status, headers: h }; } }
        return { status: res.status, headers: h, body: buf };
      } catch (e) { throw e instanceof ProviderError ? e : new ProviderError('Instagram could not be reached.'); } finally { clearTimeout(t); }
    },
  };
}
