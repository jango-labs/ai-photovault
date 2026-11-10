import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { deriveHandler, markDerivativeFailed } from '../ingest/derive-job.js';
import { IngestService } from '../ingest/service.js';
import { makeJpeg } from '../ingest/testkit.js';
import { JobWorker } from '../jobs/worker.js';
import { EditService } from '../library/edit.js';
import { PROMPT_VERSION, analyzeHandler } from './service.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient, B: ApiClient; let ua: string; let src: string, deriv: string, state: string;
const dirs: string[] = [];
const mk = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ai-it-'))); dirs.push(d); return d; };
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };
const q = async <T extends object = Record<string, never>>(text: string): Promise<T[]> => (await h!.svc.unsafe(text)) as unknown as T[];
const n = async (table: string, where = 'true') => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);
const worker = () => new JobWorker(h!.svc, { 'derive.preview': deriveHandler(h!.svc, deriv), 'ai.analyze': analyzeHandler(h!.svc, deriv) }, { onDead: markDerivativeFailed(h!.svc), concurrency: 2, backoffBaseSeconds: 0 });
const importAll = async (count = 3) => {
  for (let i = 0; i < count; i++) await makeJpeg(path.join(src, `2024/Kenya/p${i}.jpg`), { width: 320, height: 214, pattern: i * 5 + 1, color: { r: 40 + i * 40, g: 90, b: 140 } });
  await new IngestService({ sql: h!.app, policy: { approved: [{ path: src, modes: ['DRY_RUN', 'APPLY'], approvedAt: 't' }] }, derivativesDir: deriv }).run(ua, src, 'APPLY');
  await worker().drain();
};
const photoIds = async () => (await q<{ id: string }>(`SELECT id FROM photos ORDER BY created_at, id`)).map((r) => r.id);

beforeAll(async () => { h = await tryHandles(); }, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app?.close(); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
beforeEach(async () => {
  if (!h) return;
  await app?.close(); await wipe(h.svc); src = mk(); deriv = mk(); state = mk();
  app = makeApp(h, { derivativesDir: deriv, stateDir: state, ingestDir: src });
  ua = await makeUser(h.svc, 'a@example.test'); await makeUser(h.svc, 'b@example.test');
  A = await new ApiClient(app).signIn('a@example.test'); B = await new ApiClient(app).signIn('b@example.test');
});

describe('analysis pipeline (offline, free)', () => {
  it('previews are followed automatically by a local analysis; nothing is sent anywhere or spent', async (ctx) => {
    need(ctx); await importAll(3);
    expect(await n('ai_analyses')).toBe(3);
    const rows = await q<{ provider: string; model: string; mode: string; prompt_version: string; scores: Record<string, number | null>; primary_subject: string; wildlife: unknown[] }>(`SELECT provider, model, mode, prompt_version, scores, primary_subject, wildlife FROM ai_analyses`);
    for (const r of rows) {
      expect(r).toMatchObject({ provider: 'local-image', model: 'local-image-v1', mode: 'local', prompt_version: PROMPT_VERSION, primary_subject: 'not identified', wildlife: [] });
      expect(r.scores.sharpness).toBeGreaterThanOrEqual(0); expect(r.scores.storytelling).toBeNull(); expect(r.scores.uniqueness).toBeNull();
    }
    expect(await n('photo_species')).toBe(0);                                                          // it does not claim a species it cannot know
    expect(await n('ai_usage_ledger')).toBe(0); expect((await q<{ live_enabled: boolean }>(`SELECT live_enabled FROM ai_budget`)).every((b) => !b.live_enabled)).toBe(true);
    expect((await A.json('GET', '/api/library/photos?ai=analyzed&limit=10')).body.total).toBe(3); expect((await A.json('GET', '/api/library/photos?ai=none&limit=10')).body.total).toBe(0);
    const id = (await photoIds())[0]!; const d = (await A.json('GET', `/api/library/photos/${id}`)).body; expect(d.ai.status).toBe('analyzed'); expect(d.ai.analysis.mode).toBe('local');
  });
  it('autoAnalyze can be switched off; the queue is then empty until you ask', async (ctx) => {
    need(ctx); expect((await A.json('PUT', '/api/ai/settings', { autoAnalyze: false })).body).toMatchObject({ autoAnalyze: false, provider: 'local-image' });
    await importAll(2); expect(await n('ai_analyses')).toBe(0); expect(await n('jobs', `kind = 'ai.analyze'`)).toBe(0);
    const r = (await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: false })).body; expect(r).toMatchObject({ queued: 2, alreadyAnalysed: 0, waitingForPreviews: 0 });
    expect((await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: false })).body.queued).toBe(0);     // already queued: not doubled
    await worker().drain(); expect(await n('ai_analyses')).toBe(2);
    expect((await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: false })).body).toMatchObject({ queued: 0, alreadyAnalysed: 2 });
    expect((await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: true })).body.queued).toBe(2);        // re-analysis is explicit
    await worker().drain(); expect(await n('ai_analyses')).toBe(4);
  });
  it('photographs whose previews are not ready wait; an unanalysable version fails permanently, a not-ready preview is retried', async (ctx) => {
    need(ctx); await importAll(2);
    const [vid] = await q<{ id: string }>(`SELECT id FROM photo_versions ORDER BY id LIMIT 1`);
    await h!.svc`DELETE FROM ai_analyses`; await h!.svc`UPDATE photo_versions SET deriv_status = 'PENDING' WHERE id = ${vid!.id}`;
    expect((await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: false })).body).toMatchObject({ queued: 1, waitingForPreviews: 1 });
    await h!.svc`UPDATE photo_versions SET deriv_status = 'FAILED' WHERE id = ${vid!.id}`;
    await h!.svc`INSERT INTO jobs (user_id, kind, payload) SELECT user_id, 'ai.analyze', jsonb_build_object('versionId', id, 'photoId', photo_id) FROM photo_versions WHERE id = ${vid!.id}`;
    await worker().drain();
    expect((await q<{ state: string; last_error: string }>(`SELECT state, last_error FROM jobs WHERE payload ->> 'versionId' = '${vid!.id}' AND state = 'FAILED'`))[0]!.last_error).toMatch(/no preview could be made/);
  });
});

describe('suggestions, corrections and history', () => {
  const useMock = async () => { await A.json('PUT', '/api/ai/settings', { provider: 'mock', autoAnalyze: false }); };
  const analyseWithMock = async () => { await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: true }); await worker().drain(); };

  it('a model that names a species produces SUGGESTIONS (never facts); confirm, reject and correction are recorded and remembered', async (ctx) => {
    need(ctx); await A.json('PUT', '/api/ai/settings', { autoAnalyze: false }); await importAll(1); await useMock(); await analyseWithMock();
    const id = (await photoIds())[0]!;
    let p = (await A.json('GET', `/api/ai/photos/${id}`)).body;
    expect(p.analyses[0]).toMatchObject({ provider: 'mock', mode: 'mock', stale: false, current: true }); expect(p.species).toHaveLength(1);
    expect(p.species[0]).toMatchObject({ status: 'SUGGESTED', source: 'AI_INFERRED' }); const link = p.species[0].id; const name = p.species[0].name;
    expect((await A.json('POST', `/api/ai/photos/${id}/species/${link}`, { action: 'reject' })).status).toBe(200);
    await analyseWithMock();
    p = (await A.json('GET', `/api/ai/photos/${id}`)).body;
    expect(p.species).toHaveLength(1); expect(p.species[0]).toMatchObject({ id: link, status: 'REJECTED' });                         // the same suggestion is not proposed again
    expect(p.analyses).toHaveLength(2);                                                                                           // history keeps both
    expect((await A.json('POST', `/api/ai/photos/${id}/species/${link}`, { action: 'confirm' })).status).toBe(200);                 // you can change your mind
    await analyseWithMock(); expect((await A.json('GET', `/api/ai/photos/${id}`)).body.species[0]).toMatchObject({ status: 'CONFIRMED', source: 'AI_INFERRED' });     // confirmed stays confirmed
    expect((await A.json('POST', `/api/ai/photos/${id}/species`, { commonName: 'African wild dog', scientificName: 'Lycaon pictus', replaces: link })).status).toBe(200);
    p = (await A.json('GET', `/api/ai/photos/${id}`)).body;
    const dog = p.species.find((s: { name: string }) => s.name === 'African wild dog'); expect(dog).toMatchObject({ status: 'CONFIRMED', source: 'USER_DEFINED', confidence: null, scientific: 'Lycaon pictus' });
    expect(p.species.find((s: { name: string }) => s.name === name)).toMatchObject({ status: 'REJECTED' });
    expect(p.corrections.map((c: { kind: string }) => c.kind)).toEqual(['SPECIES_CORRECT', 'SPECIES_CONFIRM', 'SPECIES_REJECT']);   // newest first: what you decided, in order
    expect(p.corrections[0].before).toMatchObject({ species: name }); expect(p.corrections[0].after).toMatchObject({ species: 'African wild dog', status: 'CONFIRMED' });
    await expect(h!.svc`UPDATE ai_corrections SET kind = 'SPECIES_ADD'`).rejects.toThrow(/append-only/); await expect(h!.svc`DELETE FROM ai_corrections`).rejects.toThrow(/append-only/);
    expect((await A.json('POST', `/api/ai/photos/${id}/species`, { commonName: 'Lion' })).status).toBe(200);                          // plain add
    expect((await q<{ n: string }>(`SELECT count(*) AS n FROM species WHERE lower(common_name) = 'lion'`))[0]!.n).toBe('1');
  });

  it('accepting an AI description records provenance AI_INFERRED, can be undone from the edit history, and is itself recorded', async (ctx) => {
    need(ctx); await importAll(1); const id = (await photoIds())[0]!;
    await A.json('PATCH', `/api/library/photos/${id}/metadata`, { description: 'Mine first.' });
    const aid = (await A.json('GET', `/api/ai/photos/${id}`)).body.analyses[0].id;
    expect((await A.json('POST', `/api/ai/photos/${id}/accept-description`, { analysisId: aid })).status).toBe(200);
    expect((await q<{ description: string; description_source: string }>(`SELECT description, description_source FROM photos`))[0]).toMatchObject({ description_source: 'AI_INFERRED' });
    const hist = (await A.json('GET', `/api/library/photos/${id}/history`)).body.edits; expect(hist[0]).toMatchObject({ field: 'description', newSource: 'AI_INFERRED', oldValue: 'Mine first.', oldSource: 'USER_DEFINED' });
    expect((await A.json('POST', `/api/library/photos/${id}/history/${hist[0].id}/undo`)).status).toBe(200);
    expect((await q<{ description: string; description_source: string }>(`SELECT description, description_source FROM photos`))[0]).toMatchObject({ description: 'Mine first.', description_source: 'USER_DEFINED' });
    expect(await n('ai_corrections', `kind = 'DESCRIPTION_ACCEPT'`)).toBe(1);
    expect((await A.json('POST', `/api/ai/photos/${id}/accept-description`, { analysisId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    void EditService;
  });

  it('a newer analysis method marks older analyses stale and re-analysis queues exactly those photographs', async (ctx) => {
    need(ctx); await importAll(2);
    // analyses are immutable: simulate an old method by inserting an old-prompt analysis for a photograph that has none of the current
    await h!.svc`DELETE FROM ai_analyses`;
    await h!.svc`INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, description) SELECT user_id, id, 'local-image', 'local-image-v0', 'local-0', 'local', 'old' FROM photo_versions WHERE state = 'ACTIVE'`;
    const st = (await A.json('GET', '/api/ai/status')).body; expect(st).toMatchObject({ photos: 2, analysed: 2, stale: 2, promptVersion: PROMPT_VERSION });
    expect((await A.json('POST', '/api/ai/analyze', { target: { query: { view: 'all' } }, force: false })).body.queued).toBe(2);
    await worker().drain(); expect((await A.json('GET', '/api/ai/status')).body.stale).toBe(0);
  });
});

describe('live AI cannot be switched on by accident, and the API is protected', () => {
  it('there is no hosted provider to choose, and the budget row refuses live without an approval stamp', async (ctx) => {
    need(ctx);
    const st = (await A.json('GET', '/api/ai/status')).body;
    expect(st.live).toMatchObject({ enabled: false, spendRecords: 0, spentUsd: 0 }); expect(st.providers.find((p: { id: string }) => p.id === 'hosted')).toMatchObject({ available: false });
    expect((await A.json('PUT', '/api/ai/settings', { provider: 'hosted' })).status).toBe(400); expect((await A.json('PUT', '/api/ai/settings', {})).status).toBe(400);
    await h!.svc`INSERT INTO ai_budget (user_id) VALUES (${ua}) ON CONFLICT DO NOTHING`;
    await expect(h!.svc`UPDATE ai_budget SET live_enabled = true WHERE user_id = ${ua}`).rejects.toThrow(/check/i);
    await expect(h!.app`SELECT 1`).resolves.toBeTruthy();
  });
  it('every AI endpoint needs a session; changes need CSRF; photographs and corrections belong to their owner', async (ctx) => {
    need(ctx); await importAll(1); const id = (await photoIds())[0]!; const anon = new ApiClient(app);
    for (const [m, u, b] of [['GET', '/api/ai/status'], ['PUT', '/api/ai/settings', { autoAnalyze: true }], ['POST', '/api/ai/analyze', { target: { ids: [id] } }], ['GET', `/api/ai/photos/${id}`], ['POST', `/api/ai/photos/${id}/analyze`, {}], ['POST', `/api/ai/photos/${id}/species`, { commonName: 'x' }]] as Array<['GET' | 'PUT' | 'POST', string, unknown?]>)
      expect((await anon.json(m, u, b)).status, `${m} ${u}`).toBe(401);
    expect((await A.req('PUT', '/api/ai/settings', { autoAnalyze: false }, { csrf: false })).statusCode).toBe(403);
    expect((await B.json('GET', `/api/ai/photos/${id}`)).status).toBe(404); expect((await B.json('POST', `/api/ai/photos/${id}/analyze`, {})).status).toBe(404);
    expect((await B.json('POST', `/api/ai/photos/${id}/species`, { commonName: 'Lion' })).status).toBe(404);
    expect((await B.json('POST', '/api/ai/analyze', { target: { ids: [id] }, force: true })).body.queued).toBe(0);                    // B cannot queue A's photograph
    expect((await B.json('GET', '/api/ai/status')).body).toMatchObject({ photos: 0, analysed: 0 });
    expect((await A.json('POST', '/api/ai/analyze', { target: { ids: [] } })).status).toBe(400); expect((await A.json('POST', `/api/ai/photos/${id}/species`, { commonName: '' })).status).toBe(400);
  });
});
