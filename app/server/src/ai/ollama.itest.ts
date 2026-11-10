import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import type { Job } from '../jobs/worker.js';
import { OllamaClient, ollamaConfigFromEnv } from './ollama.js';
import { AiService, analyzeHandler, embedTextHandler, makeGateway } from './service.js';

/** The same stand-in for Ollama as the unit tests, but its “embedding model” knows that a puppy is a dog — which plain word matching cannot. */
const CONCEPTS: string[][] = [['dog', 'puppy', 'hound', 'canine'], ['buffalo', 'bovine', 'cattle'], ['mountain', 'peak', 'summit'], ['ocean', 'sea', 'beach', 'coast']];
const embedText = (t: string) => { const v = new Array(768).fill(0.001) as number[]; const words = t.toLowerCase().split(/[^a-z]+/); CONCEPTS.forEach((c, i) => { if (words.some((w) => c.includes(w))) v[i] = 1; }); return v; };
let server: http.Server; let base: string; let models: unknown = [{ name: 'gemma4:e4b', capabilities: ['vision'] }, { name: 'nomic-embed-text:latest', capabilities: ['embedding'] }]; let nextDescription = ''; let chatCalls = 0; let down = false;
let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let uid: string; let deriv: string; const dirs: string[] = [];
const answer = (d: string) => JSON.stringify({ primarySubject: d, description: d, tags: d.toLowerCase().split(' ').slice(0, 3), scenes: [], composition: 0.6, subjectIsolation: 0.5, lighting_quality: 0.6, impact: 0.5, wildlife: [] });
const job = (versionId: string): Job => ({ id: 'j', user_id: uid, kind: 'ai.analyze', payload: { versionId }, attempts: 1, max_attempts: 3 });

beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  server = http.createServer((req, res) => { const c: Buffer[] = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
    const body = c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}; const send = (s: number, o: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (down) return send(503, { error: 'down' });
    if (req.url === '/api/tags') return send(200, { models });
    if (req.url === '/api/chat') { chatCalls++; return send(200, { message: { content: answer(nextDescription) } }); }
    if (req.url === '/api/embed') return send(200, { embeddings: (body.input as string[]).map((t) => embedText(t.replace(/^search_(document|query): /, ''))) });
    send(404, {}); }); }).listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PHOTOVAULT_OLLAMA_URL = base;
  await wipe(h.svc); uid = await makeUser(h.svc, 'ai@example.test'); deriv = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ai-'))); dirs.push(deriv);
  app = makeApp(h, { derivativesDir: deriv }); A = await new ApiClient(app).signIn('ai@example.test');
}, 60_000);
afterAll(async () => { delete process.env.PHOTOVAULT_OLLAMA_URL; if (h) { await wipe(h.svc); await app.close(); await h.close(); server.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const photo = async (title: string) => { const o = await seedOne(h!.svc, uid, { title, relpath: `2026/Test/${title}.jpg` }); fs.mkdirSync(path.join(deriv, o.versionId), { recursive: true });
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90 + title.length, g: 120, b: 80 } } }).jpeg().toFile(path.join(deriv, o.versionId, 'view.jpg')); await h!.svc`UPDATE photo_versions SET deriv_status = 'READY' WHERE id = ${o.versionId}`; return o; };

describe('real local analysis, text embeddings and meaning-based search (stand-in Ollama)', () => {
  it('cannot be chosen while the model is missing (409, said plainly); can once it is installed', async (ctx) => {
    need(ctx); models = [{ name: 'other:latest', capabilities: ['completion'] }];
    const no = await A.json('PUT', '/api/ai/settings', { provider: 'ollama' }); expect(no.status).toBe(409); expect(no.body.message).toMatch(/not installed or has no vision/);
    expect((await A.json('GET', '/api/ai/status')).body.providers.find((p: { id: string }) => p.id === 'ollama')).toMatchObject({ available: false });
    await new Promise((r) => setTimeout(r, 15_100));                                                                           // the availability probe is cached for 15 s
    models = [{ name: 'gemma4:e4b', capabilities: ['vision'] }, { name: 'nomic-embed-text:latest', capabilities: ['embedding'] }];
    const ok = await A.json('PUT', '/api/ai/settings', { provider: 'ollama' }); expect(ok.status).toBe(200); expect(ok.body.provider).toBe('ollama');
    expect((await A.json('GET', '/api/ai/status')).body.providers.find((p: { id: string }) => p.id === 'ollama')).toMatchObject({ available: true, ready: true });
  }, 60_000);

  it('stores the model that wrote each analysis, queues and writes its text embedding, and never falls back to another provider when Ollama is down', async (ctx) => {
    need(ctx); const dog = await photo('IMG_0001'); const cow = await photo('IMG_0002'); const sea = await photo('IMG_0003');
    const client = new OllamaClient({ ...ollamaConfigFromEnv({}), baseUrl: base, timeoutMs: 3000 }); const gw = makeGateway(client); const run = analyzeHandler(h!.svc, deriv, gw); const embed = embedTextHandler(h!.svc, client);
    for (const [o, d] of [[dog, 'A small dog on a lawn'], [cow, 'A herd of buffalo grazing'], [sea, 'Waves on a beach']] as const) { nextDescription = d; await run(job(o.versionId)); await embed({ ...job(o.versionId), kind: 'embed.text' }); }
    const rows = await h!.svc<{ provider: string; model: string; mode: string; prompt_version: string; description: string }[]>`SELECT provider, model, mode, prompt_version, description FROM ai_analyses ORDER BY description`;
    expect(rows).toHaveLength(3); expect(rows[0]).toMatchObject({ provider: 'ollama', model: 'gemma4:e4b', mode: 'local', prompt_version: 'ollama-v2' });
    expect(await h!.svc`SELECT 1 FROM jobs WHERE kind = 'embed.text'`).toHaveLength(3);                                          // each analysis queued its own embedding job
    expect(await h!.svc`SELECT dimensions FROM photo_embeddings WHERE model = 'ollama:nomic-embed-text' AND kind = 'text'`).toEqual([{ dimensions: 768 }, { dimensions: 768 }, { dimensions: 768 }]);
    const calls = chatCalls; await run(job(dog.versionId)); expect(chatCalls).toBe(calls);                                       // idempotent: the same (version, provider, prompt) is not analysed twice
    const fresh = await photo('IMG_0004'); down = true;
    await expect(run(job(fresh.versionId))).rejects.toThrow(/Ollama answered 503/); down = false;                                // the job fails and will be retried; nothing is stored by a stand-in
    expect(await h!.svc`SELECT 1 FROM ai_analyses WHERE photo_version_id = ${fresh.versionId}`).toHaveLength(0);
  }, 60_000);

  it('search finds a puppy photograph by MEANING (the word is nowhere in the library), says it did, and says honestly when it could not', async (ctx) => {
    need(ctx);
    const r = (await A.json('GET', '/api/search?q=puppy&limit=20')).body;
    expect(r.semantic).toMatchObject({ available: true, used: true, mode: 'description-embedding', model: 'ollama:nomic-embed-text', coverage: { embedded: 3, photos: 4 } }); expect(r.semantic.reason).toMatch(/3 of 4 photographs/);
    expect(r.items[0].filename).toBe('IMG_0001.jpg'); expect(r.items.map((i: { filename: string }) => i.filename)).not.toContain('IMG_0003.jpg');
    const w = (await A.json('GET', '/api/search?q=buffalo')).body; expect(w.items[0].filename).toBe('IMG_0002.jpg'); expect(w.semantic.used).toBe(true);        // words AND meaning agree
    down = true; const off = (await A.json('GET', '/api/search?q=puppy')).body; down = false;
    expect(off.semantic).toMatchObject({ available: false, used: false }); expect(off.semantic.reason).toMatch(/unavailable right now/); expect(off.items).toHaveLength(0);       // honest fallback: words only, and nothing is claimed
    const filtered = (await A.json('GET', '/api/search?q=puppy&limit=20&exclude=nothing')).body; expect(filtered.total).toBeGreaterThanOrEqual(1);
  });

  it('a library with no local-model analyses says meaning-based search is not available instead of pretending', async (ctx) => {
    need(ctx); await h!.svc`DELETE FROM photo_embeddings`;
    const r = (await A.json('GET', '/api/search?q=puppy')).body; expect(r.semantic).toMatchObject({ available: false, used: false }); expect(r.semantic.reason).toMatch(/needs photographs analysed by the local vision model/);
  });
});
void AiService;
