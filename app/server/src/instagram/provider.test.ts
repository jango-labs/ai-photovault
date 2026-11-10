import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphInstagramProvider, MockInstagramProvider, ProviderError, RateLimited, TokenExpired, type Transport } from './provider.js';

const made: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-igp-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function archive(n: number) {
  const d = tmp(); fs.mkdirSync(path.join(d, 'img'));
  const posts = [];
  for (let i = 0; i < n; i++) { await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: i * 5, g: 80, b: 120 } } }).jpeg().toFile(path.join(d, 'img', `${i}.jpg`)); posts.push({ id: `p${i}`, postedAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(), caption: `post ${i}`, media: [{ id: `m${i}`, file: `img/${i}.jpg` }] }); }
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ posts }));
  return d;
}

describe('MockInstagramProvider (local archive)', () => {
  it('lists newest first, in pages, with a cursor that ends', async () => {
    const p = new MockInstagramProvider(await archive(60)); const a = await p.listPosts(null);
    expect(a.posts).toHaveLength(25); expect(a.posts[0]!.platformPostId).toBe('p59'); expect(a.next).toBe('25');
    const b = await p.listPosts(a.next); const c = await p.listPosts(b.next);
    expect(c.posts).toHaveLength(10); expect(c.next).toBeNull(); expect(new Set([...a.posts, ...b.posts, ...c.posts].map((x) => x.platformPostId)).size).toBe(60);
  });
  it('serves the image bytes of a post', async () => {
    const p = new MockInstagramProvider(await archive(2)); const post = (await p.listPosts(null)).posts[0]!; const bytes = await p.fetchMedia(post.media[0]!);
    expect((await sharp(bytes).metadata()).width).toBe(40);
  });
  it('refuses a missing archive, a bad cursor, a malformed manifest, and files outside its folder', async () => {
    await expect(new MockInstagramProvider(tmp()).listPosts(null)).rejects.toThrow(/not been created/);
    const d = await archive(2); await expect(new MockInstagramProvider(d).listPosts('-3')).rejects.toBeInstanceOf(ProviderError); await expect(new MockInstagramProvider(d).listPosts('x')).rejects.toBeInstanceOf(ProviderError);
    fs.writeFileSync(path.join(d, 'manifest.json'), '{"posts":[{"id":1}]}'); await expect(new MockInstagramProvider(d).listPosts(null)).rejects.toThrow(/not valid/);
    const p = new MockInstagramProvider(d);
    for (const f of ['../secret.jpg', '/etc/passwd', 'img/../../x.jpg']) await expect(p.fetchMedia({ platformMediaId: 'x', mediaUrl: `file:${f}` }), f).rejects.toBeInstanceOf(ProviderError);
    fs.symlinkSync('/etc/hosts', path.join(d, 'img', 'link.jpg')); await expect(p.fetchMedia({ platformMediaId: 'x', mediaUrl: 'file:img/link.jpg' })).rejects.toThrow(/outside/);
    await expect(p.fetchMedia({ platformMediaId: 'x', mediaUrl: 'https://example.test/a.jpg' })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('GraphInstagramProvider (the official API; never constructed by the app in this build)', () => {
  const page = { data: [
    { id: '1', caption: 'one #a', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/A/', timestamp: '2025-03-01T10:00:00+0000', media_url: 'https://cdn.example.test/1.jpg' },
    { id: '2', media_type: 'VIDEO', timestamp: '2025-02-01T10:00:00+0000', media_url: 'https://cdn.example.test/2.mp4' },
    { id: '3', media_type: 'CAROUSEL_ALBUM', timestamp: '2025-01-01T10:00:00+0000', children: { data: [{ id: '3a', media_type: 'IMAGE', media_url: 'https://cdn.example.test/3a.jpg' }, { id: '3b', media_type: 'VIDEO', media_url: 'https://cdn.example.test/3b.mp4' }] } },
  ], paging: { cursors: { after: 'CUR2' }, next: 'https://graph.instagram.com/next' } };
  const fake = (responses: Array<{ status: number; headers?: Record<string, string>; json?: unknown; body?: Buffer }>) => { const calls: Array<{ url: string; headers: Record<string, string> }> = []; const t: Transport = { async get(url, headers) { calls.push({ url, headers }); const r = responses.shift() ?? { status: 500 }; return { headers: {}, ...r }; } }; return { t, calls }; };
  const make = (t: Transport, enabled = true) => new GraphInstagramProvider({ enabled, igUserId: '1784', token: () => 'SECRET-TOKEN', transport: t, live: true });      // `live` is passed here only to exercise the protocol against a fake transport

  it('is disabled unless explicitly enabled', () => { expect(() => make(fake([]).t, false)).toThrow(/disabled in this build/); });
  it('reads a page: images only (videos have no still), carousel children, the cursor — and the token travels only in a header', async () => {
    const f = fake([{ status: 200, json: page }]); const r = await make(f.t).listPosts(null);
    expect(r.posts.map((p) => [p.platformPostId, p.mediaType, p.media.map((m) => m.platformMediaId)])).toEqual([['1', 'IMAGE', ['1']], ['3', 'CAROUSEL_ALBUM', ['3a']]]); expect(r.next).toBe('CUR2');
    expect(f.calls[0]!.url).toContain('/1784/media?fields='); expect(f.calls[0]!.url).toContain('limit=25'); expect(f.calls[0]!.url).not.toContain('SECRET-TOKEN'); expect(f.calls[0]!.headers.authorization).toBe('Bearer SECRET-TOKEN');
    expect(r.posts[0]!.postedAt).toBe('2025-03-01T10:00:00.000Z');
  });
  it('continues from a cursor, and ends when there is no next page', async () => {
    const f = fake([{ status: 200, json: { data: [], paging: {} } }]); const r = await make(f.t).listPosts('CUR2'); expect(f.calls[0]!.url).toContain('after=CUR2'); expect(r).toEqual({ posts: [], next: null });
  });
  it('maps Instagram’s errors: expired token → TokenExpired, throttling → RateLimited (with the wait), others → a generic ProviderError that does not echo the message', async () => {
    await expect(make(fake([{ status: 400, json: { error: { code: 190, message: 'token SECRET-TOKEN expired' } } }]).t).listPosts(null)).rejects.toBeInstanceOf(TokenExpired);
    await expect(make(fake([{ status: 401, json: {} }]).t).listPosts(null)).rejects.toBeInstanceOf(TokenExpired);
    const rl = await make(fake([{ status: 400, headers: { 'retry-after': '120' }, json: { error: { code: 4 } } }]).t).listPosts(null).catch((e) => e); expect(rl).toBeInstanceOf(RateLimited); expect((rl as RateLimited).retryAfterSeconds).toBe(120);
    const e = await make(fake([{ status: 500, json: { error: { code: 2, message: 'internal: SECRET-TOKEN' } } }]).t).listPosts(null).catch((x) => x); expect(e).toBeInstanceOf(ProviderError); expect(String(e.message)).not.toContain('SECRET-TOKEN');
    await expect(make(fake([{ status: 200, json: { nope: 1 } }]).t).listPosts(null)).rejects.toThrow(/unexpected shape/);
  });
  it('downloads images only over https and never sends the access token to the CDN', async () => {
    const f = fake([{ status: 200, body: Buffer.from('jpegbytes') }]); const b = await make(f.t).fetchMedia({ platformMediaId: '1', mediaUrl: 'https://cdn.example.test/1.jpg' });
    expect(b.toString()).toBe('jpegbytes'); expect(JSON.stringify(f.calls[0]!.headers)).not.toContain('SECRET-TOKEN');
    await expect(make(fake([]).t).fetchMedia({ platformMediaId: '1', mediaUrl: 'http://cdn.example.test/1.jpg' })).rejects.toBeInstanceOf(ProviderError);
    await expect(make(fake([{ status: 403 }]).t).fetchMedia({ platformMediaId: '1', mediaUrl: 'https://cdn.example.test/1.jpg' })).rejects.toBeInstanceOf(ProviderError);
  });
  it('refuses the real Instagram unless live is passed, and any non-https non-loopback address even then', () => {
    const t: Transport = { get: async () => ({ status: 200, headers: {} }) };
    expect(() => new GraphInstagramProvider({ enabled: true, igUserId: '1', token: () => 't', transport: t })).toThrow(/until you approve/);
    expect(() => new GraphInstagramProvider({ enabled: true, igUserId: '1', token: () => 't', transport: t, baseUrl: 'http://graph.instagram.com', live: true })).toThrow(/until you approve/);
    expect(() => new GraphInstagramProvider({ enabled: true, igUserId: '1', token: () => 't', transport: t, baseUrl: 'http://127.0.0.1:9/v1' })).not.toThrow();            // a sandbox on this computer
  });
  it('the app constructs it in exactly one place — the sync job, only for a connected account, only when a Meta app is configured — and never with a literal live: true', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname); const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !/\.(test|itest)\.ts$/.test(f));
    const uses = sources.filter((f) => /new GraphInstagramProvider\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(uses).toEqual(['sync.ts']);
    const sync = fs.readFileSync(path.join(dir, 'sync.ts'), 'utf8'); expect(sync).toMatch(/if \(!live\?\.cfg\) throw new PermanentJobError/); expect(sync).toMatch(/live: live\.cfg\.live === true/);
    for (const f of sources) expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/live:\s*true/);
  });
});
