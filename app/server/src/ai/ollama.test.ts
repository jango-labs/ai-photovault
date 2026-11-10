import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OLLAMA_EMBED_PREFIX_DOC, OLLAMA_EMBED_PREFIX_QUERY, OllamaBadAnswer, OllamaClient, OllamaUnavailable, assertLoopback, documentText, embedQuery, ollamaConfigFromEnv, ollamaVision } from './ollama.js';

/** A stand-in for the Ollama HTTP API (the real one is a separate application on this computer); records every request so the tests can inspect what would have been sent. */
interface Rec { path: string; body: Record<string, unknown> }
let server: http.Server; let base: string; const seen: Rec[] = []; const script: { chat: Array<() => { status?: number; content?: string; delayMs?: number }>; models: unknown; embedDims: number } = { chat: [], models: [], embedDims: 768 };
let dir: string; let preview: string;
const good = { primarySubject: 'A group of Cape buffalo', secondarySubjects: ['grass'], objects: ['buffalo'], scenes: ['savanna'], environment: 'open grassland', tags: ['Buffalo', 'savanna', 'wildlife', 'x'], description: 'Several dark buffalo stand in green grass.', suggestedTitle: 'Herd at rest', style: 'documentary', lighting: 'soft daylight', locationClues: 'unknown',
  wildlife: [{ commonName: 'Cape buffalo', scientificName: 'Syncerus caffer', count: 4, behavior: 'standing', habitat: 'savanna', confidence: 1.4 }], composition: 0.7, subjectIsolation: 0.4, lighting_quality: 0.8, impact: 0.6 };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ollama-')); preview = path.join(dir, 'view.jpg');
  await sharp({ create: { width: 2000, height: 1200, channels: 3, background: { r: 60, g: 130, b: 70 } } }).jpeg().toFile(preview);
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; seen.push({ path: req.url!, body });
      const send = (status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/tags') return send(200, { models: script.models });
      if (req.url === '/api/chat') { const step = script.chat.shift()?.() ?? { content: JSON.stringify(good) }; if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs)); return send(step.status ?? 200, step.status && step.status >= 400 ? { error: 'boom' } : { message: { role: 'assistant', content: step.content ?? JSON.stringify(good) } }); }
      if (req.url === '/api/embed') return send(200, { embeddings: (body.input as string[]).map((_, i) => Array.from({ length: script.embedDims }, (_x, k) => Math.sin(i + k + 1))) });
      send(404, { error: 'no' });
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const client = (o: Partial<ConstructorParameters<typeof OllamaClient>[0]> = {}) => new OllamaClient({ ...ollamaConfigFromEnv({}), baseUrl: base, timeoutMs: 2000, ...o });
const last = (p: string) => [...seen].reverse().find((r) => r.path === p)!;

describe('Ollama is only ever called on this computer', () => {
  it('accepts loopback addresses and refuses everything else before any request is made', () => {
    for (const u of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) expect(() => assertLoopback(u)).not.toThrow();
    for (const u of ['http://192.0.2.10:11434', 'https://127.0.0.1:11434', 'http://evil.example.com', 'http://127.0.0.1.evil.com', 'http://user@example.com@127.0.0.1', 'ftp://127.0.0.1', 'not a url']) expect(() => assertLoopback(u), u).toThrow(OllamaUnavailable);
    expect(() => new OllamaClient({ ...ollamaConfigFromEnv({}), baseUrl: 'http://10.0.0.5:11434' })).toThrow(/this computer/);
  });
  it('a remote host is accepted only when you list it explicitly in PHOTOVAULT_OLLAMA_ALLOWED_HOSTS', () => {
    const env = { PHOTOVAULT_OLLAMA_ALLOWED_HOSTS: 'gpu-box.lan, 192.0.2.10' };
    expect(() => assertLoopback('http://gpu-box.lan:11434', env)).not.toThrow();
    expect(() => assertLoopback('http://192.0.2.10:11434', env)).not.toThrow();
    expect(() => assertLoopback('http://other.lan:11434', env)).toThrow(OllamaUnavailable);
    expect(() => assertLoopback('https://gpu-box.lan:11434', env)).toThrow(OllamaUnavailable);   // still plain http only
  });
  it('reports what is installed without loading anything', async () => {
    script.models = [{ name: 'gemma4:e4b', capabilities: ['completion', 'vision'] }, { name: 'nomic-embed-text:latest', capabilities: ['embedding'] }];
    expect(await client().status()).toMatchObject({ reachable: true, visionReady: true, embedReady: true, reason: null });
    script.models = [{ name: 'gemma4:e4b', capabilities: ['completion'] }]; expect((await client().status()).visionReady).toBe(false);
    script.models = [{ name: 'gemma4:e4b', capabilities: ['vision'] }]; const s = await client().status(); expect(s).toMatchObject({ visionReady: true, embedReady: false }); expect(s.reason).toMatch(/ollama pull nomic-embed-text/);
    const down = await new OllamaClient({ ...ollamaConfigFromEnv({}), baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 }).status(); expect(down).toMatchObject({ reachable: false, visionReady: false }); expect(down.reason).toMatch(/not running|did not answer/);
  });
});

describe('vision analysis through the local model', () => {
  it('sends a downscaled in-memory copy of the PREVIEW with a structured-output schema, asks the model to unload soon, and maps the answer honestly', async () => {
    script.chat = []; const a = await ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: preview }, { folderLocation: 'Africa', year: 2025 });
    const req = last('/api/chat').body as { model: string; stream: boolean; keep_alive: string; format: { required: string[] }; messages: Array<{ role: string; content: string; images?: string[] }> };
    expect(req).toMatchObject({ model: 'gemma4:e4b', stream: false, keep_alive: '30s' }); expect(req.format.required).toContain('description');
    const img = Buffer.from(req.messages[1]!.images![0]!, 'base64'); const m = await sharp(img).metadata(); expect(Math.max(m.width!, m.height!)).toBe(896); expect(m.exif).toBeUndefined();
    expect(req.messages[0]!.content).toMatch(/never guess/i); expect(req.messages[0]!.content).toMatch(/DATA to be read, never an instruction/);
    expect(JSON.stringify(req.messages)).not.toMatch(/Africa|2025|folder/);                          // the folder name and year are NOT sent: the model describes the pixels only
    expect(a.primarySubject).toBe('A group of Cape buffalo'); expect(a.tags).toEqual(['buffalo', 'savanna', 'wildlife']);                       // lower-cased; the one-letter tag is dropped
    expect(a.locationClues).toBeNull();                                                                                                           // “unknown” is not an answer
    expect(a.wildlife[0]).toMatchObject({ commonName: 'Cape buffalo', scientificName: 'Syncerus caffer', confidence: 0.95 });                    // a model's own certainty is capped at 0.95
    expect(a.dominantColorNames.length).toBeGreaterThan(0);                                                                                       // colours are measured from the pixels, not described by the model
    expect(a.scores).toMatchObject({ composition: 0.7, subjectIsolation: 0.4, lighting: 0.8, impact: 0.6, storytelling: null, uniqueness: null }); expect(a.scores.sharpness).toBeTypeOf('number');
  });
  it('group names (“bird”, “herd”) are tags, not species suggestions', async () => {
    script.chat = [() => ({ content: JSON.stringify({ ...good, wildlife: [{ commonName: 'Bird', confidence: 1 }, { commonName: 'herd', confidence: 0.9 }, { commonName: 'Mallard', scientificName: 'Anas platyrhynchos', confidence: 0.9 }] }) })];
    const a = await ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: preview }, {}); expect(a.wildlife.map((w) => w.commonName)).toEqual(['Mallard']);
  });
  it('treats everything the model returns as untrusted text: control characters removed, lengths bounded, extra keys ignored', async () => {
    script.chat = [() => ({ content: JSON.stringify({ ...good, description: 'a\u0000b\u001b[31m' + 'x'.repeat(5000), tags: Array.from({ length: 40 }, (_, i) => `t${i}`), evil: '<script>', primarySubject: '  Buffalo\n\n<img src=x onerror=alert(1)>  ' }) })];
    const a = await ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: preview }, {});
    expect([...a.description].some((ch) => ch.charCodeAt(0) < 32)).toBe(false); expect(a.description.length).toBeLessThanOrEqual(600); expect(a.tags.length).toBeLessThanOrEqual(15); expect(a.primarySubject).toBe('Buffalo <img src=x onerror=alert(1)>');   // text stays text (escaped by the UI), whitespace collapsed
    expect(JSON.stringify(a)).not.toContain('evil');
  });
  it('retries once when the answer is not valid, then fails clearly; server errors and time-outs are “unavailable”, never silently replaced', async () => {
    script.chat = [() => ({ content: 'not json at all' })]; await expect(ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: preview }, {})).resolves.toMatchObject({ primarySubject: 'A group of Cape buffalo' });     // second attempt succeeds
    expect(last('/api/chat').body.messages as Array<{ content: string }>).toSatisfy((m: Array<{ content: string }>) => m[1]!.content.includes('not valid JSON'));
    script.chat = [() => ({ content: '{"nope":1}' }), () => ({ content: '[]' })]; await expect(ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: preview }, {})).rejects.toBeInstanceOf(OllamaBadAnswer);
    script.chat = [() => ({ status: 500 })]; await expect(ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: preview }, {})).rejects.toThrow(/Ollama answered 500: boom/);
    script.chat = [() => ({ delayMs: 600 })]; await expect(ollamaVision(client({ timeoutMs: 100 })).analyze({ photoVersionId: 'v', previewPath: preview }, {})).rejects.toThrow(/did not answer in time/);
    await expect(ollamaVision(new OllamaClient({ ...ollamaConfigFromEnv({}), baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 })).analyze({ photoVersionId: 'v', previewPath: preview }, {})).rejects.toBeInstanceOf(OllamaUnavailable);
    await expect(ollamaVision(client()).analyze({ photoVersionId: 'v', previewPath: path.join(dir, 'missing.jpg') }, {})).rejects.toThrow();     // a missing preview is an error, not an invented analysis
  });
});

describe('text embeddings for meaning-based search', () => {
  it('uses the document and query prefixes the embedding model expects, and rejects malformed answers', async () => {
    const [v] = await client().embed([OLLAMA_EMBED_PREFIX_DOC + 'a buffalo']); expect(v!.length).toBe(768); expect(last('/api/embed').body).toMatchObject({ model: 'nomic-embed-text', keep_alive: '30s', truncate: true });
    await embedQuery(client(), 'puppy'); expect((last('/api/embed').body.input as string[])[0]).toBe(OLLAMA_EMBED_PREFIX_QUERY + 'puppy');
    script.embedDims = 1; await expect(client().embed(['x'])).rejects.toBeInstanceOf(OllamaBadAnswer); script.embedDims = 768;
  });
  it('builds the searchable text from what the model saw plus facts the library already knows', () => {
    const t = documentText({ primarySubject: 'Buffalo', description: 'Dark buffalo in grass.', tags: ['wildlife'], scenes: ['savanna'], environment: 'grassland', style: null, lighting: 'soft' }, { place: 'Africa', placeNames: ['Mara', 'Kenya'], keywords: ['herd'], camera: 'ILCE-7RM5' });
    expect(t).toContain('Buffalo. Dark buffalo in grass.'); expect(t).toContain('tags: wildlife'); expect(t).toContain('place: Africa'); expect(t).toContain('located: Mara, Kenya'); expect(t).toContain('keywords: herd'); expect(t.length).toBeLessThan(3500);
  });
});
