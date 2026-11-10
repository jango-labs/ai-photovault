import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { opsStatus, storageReport } from './storage.js';

let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let root: string;
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ops-')); fs.mkdirSync(path.join(root, 'deriv')); fs.writeFileSync(path.join(root, 'deriv', 'a.jpg'), Buffer.alloc(2048));
  app = makeApp(h, { derivativesDir: path.join(root, 'deriv') }); const u = await makeUser(h.svc, 'o@example.test'); await seedOne(h.svc, u, { title: 'x' }); A = await new ApiClient(app).signIn('o@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); fs.rmSync(root, { recursive: true, force: true }); } });
const need = (ctx: { skip: () => void }) => { if (!h) ctx.skip(); };

describe('operations status', () => {
  it('reports each background process by the age of its heartbeat: running, late, stopped', async (ctx) => {
    need(ctx);
    await h!.svc`DELETE FROM service_heartbeats`; await h!.svc`INSERT INTO service_heartbeats (service, instance, pid, version, at) VALUES ('worker', 'mini', 1, '0.5.0', now() - interval '10 seconds'), ('scheduler', 'mini', 2, '0.5.0', now() - interval '5 minutes'), ('agent', 'mini', 3, '0.5.0', now() - interval '3 hours')`;
    const r = (await A.json('GET', '/api/system/ops')).body; expect(Object.fromEntries(r.services.map((s: { name: string; status: string }) => [s.name, s.status]))).toEqual({ agent: 'stopped', scheduler: 'late', worker: 'running' });
  });
  it('reports NAS copies, restore tests, config bundles and escrow: never / ok / stale / failed, and a later failure shows even after an older success', async (ctx) => {
    need(ctx);
    await h!.svc`DELETE FROM backup_runs`;
    let o = (await A.json('GET', '/api/system/ops')).body.offsite; expect(o.healthy).toBe(false); expect(o.checks.map((c: { state: string }) => c.state)).toEqual(['never', 'never', 'never', 'never']); expect(o.problems[0]).toMatch(/has never completed/);
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, verified_at, verify_ok) VALUES ('NAS_COPY', now() - interval '2 hours', true, 100, 'x', now(), true), ('NAS_RESTORE_TEST', now() - interval '3 days', true, 100, 'x', now(), true), ('CONFIG_BUNDLE', now() - interval '20 days', true, 100, 'x', now(), true), ('ESCROW', now() - interval '1 day', true, 100, 'x', now(), true)`;
    o = (await A.json('GET', '/api/system/ops')).body.offsite; expect(Object.fromEntries(o.checks.map((c: { key: string; state: string }) => [c.key, c.state]))).toEqual({ nasCopy: 'ok', nasRestoreTest: 'ok', configBundle: 'stale', escrow: 'ok' }); expect(o.problems).toHaveLength(1); expect(o.problems[0]).toMatch(/too old/);
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, detail) VALUES ('NAS_COPY', now() - interval '1 hour', false, 0, 'x', ${h!.svc.json({ error: 'the NAS share is not reachable' })})`;
    o = (await A.json('GET', '/api/system/ops')).body.offsite; const c = o.checks.find((x: { key: string }) => x.key === 'nasCopy'); expect(c.state).toBe('failed'); expect(c.lastFailure.message).toBe('the NAS share is not reachable'); expect(c.lastOkAgeSeconds).toBeGreaterThan(3600); expect(o.problems.join(' ')).toMatch(/the last attempt failed — the NAS share is not reachable/);
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, verified_at, verify_ok) VALUES ('NAS_COPY', now(), true, 100, 'x', now(), true), ('CONFIG_BUNDLE', now(), true, 100, 'x', now(), true)`;
    o = (await A.json('GET', '/api/system/ops')).body.offsite; expect(o.healthy).toBe(true); expect(o.checks).toHaveLength(4);           // the originals line is absent until an originals backup has run
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, detail) VALUES ('ORIGINALS_COPY', now() - interval '1 hour', false, 0, 'x', ${h!.svc.json({ error: 'the NAS is not reachable' })})`;
    o = (await A.json('GET', '/api/system/ops')).body.offsite; expect(o.checks).toHaveLength(5); expect(o.healthy).toBe(false); expect(o.problems.join(' ')).toMatch(/Original photographs on the NAS.*failed — the NAS is not reachable/);
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, verified_at, verify_ok) VALUES ('ORIGINALS_COPY', now(), true, 100, 'x', now(), true)`;
    o = (await A.json('GET', '/api/system/ops')).body.offsite; expect(o.healthy).toBe(true);
  });
  it('knows how old the newest VERIFIED backup is; an unverified or failed one does not count; none or old means stale', async (ctx) => {
    need(ctx);
    await h!.svc`DELETE FROM backup_runs`; expect((await A.json('GET', '/api/system/ops')).body.backups).toMatchObject({ lastVerifiedDump: null, stale: true });
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, verified_at, verify_ok) VALUES ('DUMP', now() - interval '1 hour', true, 5000, 'x', NULL, NULL), ('DUMP', now() - interval '30 hours', true, 7000, 'old', now(), true), ('DUMP', now() - interval '2 hours', false, 0, 'bad', now(), false)`;
    let b = (await A.json('GET', '/api/system/ops')).body.backups; expect(b.stale).toBe(true); expect(b.lastVerifiedDump.bytes).toBe(7000);
    await h!.svc`INSERT INTO backup_runs (kind, finished_at, ok, bytes, path, verified_at, verify_ok) VALUES ('DUMP', now() - interval '3 hours', true, 9000, 'new', now(), true), ('RESTORE_TEST', now() - interval '3 hours', true, 9000, 'new', now(), true)`;
    b = (await A.json('GET', '/api/system/ops')).body.backups; expect(b).toMatchObject({ stale: false, lastVerifiedDump: { bytes: 9000 } }); expect(b.lastRestoreTest.ageSeconds).toBeGreaterThan(3 * 3600 - 60);
  });
  it('storage: database and table sizes, the sizes of the folders, free space; unset folders are reported as unset', async (ctx) => {
    need(ctx);
    const r = (await A.json('GET', '/api/system/storage')).body; expect(r.database.bytes).toBeGreaterThan(1_000_000); expect(r.database.tables.length).toBeGreaterThan(3); expect(r.database.tables[0].bytes).toBeGreaterThanOrEqual(r.database.tables[1].bytes);
    const d = r.dirs.find((x: { key: string }) => x.key === 'derivatives'); expect(d).toMatchObject({ bytes: 2048, files: 1, truncated: false }); expect(d.freeBytes).toBeGreaterThan(0); expect(r.dirs.find((x: { key: string }) => x.key === 'igMedia')).toMatchObject({ path: null, bytes: null });
    const direct = await storageReport(h!.svc, { derivatives: path.join(root, 'deriv'), igMedia: null, delivery: null, backups: null, state: null }); expect(direct.dirs[0]!.bytes).toBe(2048);
  });
  it('needs a session', async (ctx) => {
    need(ctx);
    for (const u of ['/api/system/ops', '/api/system/storage']) expect((await new ApiClient(app).json('GET', u)).status, u).toBe(401);
    expect((await opsStatus(h!.svc)).services).toBeTruthy();
  });
});
