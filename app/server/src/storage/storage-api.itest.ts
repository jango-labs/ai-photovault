import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, makeApp, makeUser, seedOne } from '../db/test-client.js';
import { tryHandles, wipe, type Handles } from '../db/testdb.js';
import { DataRoot, MARKER, type VolumeInfo } from './dataRoot.js';

const UUID = '3E1F6D2A-0B4C-4E8A-9C11-7A5B2D9F0E44';
let h: Handles | null; let app: FastifyInstance; let A: ApiClient; let mount: string; let attached = true; let photoId: string;
const dirs: string[] = [];
beforeAll(async () => {
  h = await tryHandles(); if (!h) return;
  await wipe(h.svc); const uid = await makeUser(h.svc, 'store@example.test');
  mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-drive-'))); dirs.push(mount);
  const root = path.join(mount, 'PhotoVaultData'); fs.mkdirSync(path.join(root, 'derivatives'), { recursive: true }); fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ version: 1, storageId: UUID }));
  const o = await seedOne(h.svc, uid, { title: 'x' }); photoId = o.photoId;
  fs.mkdirSync(path.join(root, 'derivatives', o.versionId)); fs.writeFileSync(path.join(root, 'derivatives', o.versionId, 'thumb.jpg'), await sharp({ create: { width: 20, height: 20, channels: 3, background: '#357' } }).jpeg().toBuffer());
  await h.svc`UPDATE photo_versions SET deriv_status = 'READY' WHERE id = ${o.versionId}`;
  const dr = new DataRoot({ storageId: UUID, ttlMs: 0, bootDevice: async () => -1, probe: async (u): Promise<VolumeInfo | null> => (attached ? { uuid: u, mountPoint: mount, writable: true } : null) });
  app = makeApp(h, { dataRoot: dr, syntheticMedia: false }); A = await new ApiClient(app).signIn('store@example.test');
}, 60_000);
afterAll(async () => { if (h) { await wipe(h.svc); await app.close(); await h.close(); } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('the API and the external photo drive', () => {
  it('serves previews from the drive found by its identity, and says plainly (503) when the drive is away; it recovers by itself', async (ctx) => {
    if (!h) return ctx.skip();
    const ok = await A.req('GET', `/api/library/photos/${photoId}/image?size=thumb`); expect(ok.statusCode).toBe(200); expect(ok.headers['content-type']).toBe('image/jpeg');
    expect((await A.json('GET', '/api/system/data-root')).body).toMatchObject({ configured: true, ready: true, reason: null, storageId: UUID, mountedAt: mount });
    attached = false;
    const gone = await A.json('GET', `/api/library/photos/${photoId}/image?size=thumb`); expect(gone.status).toBe(503); expect(gone.body.error).toBe('storage_unavailable'); expect(gone.body.message).toMatch(/not connected/);
    expect((await A.json('GET', '/api/system/data-root')).body).toMatchObject({ configured: true, ready: false, reason: 'the drive is not connected' });
    expect((await A.json('GET', '/api/library/photos?limit=5')).status).toBe(200);                                 // the library itself (database) keeps working
    attached = true; expect((await A.req('GET', `/api/library/photos/${photoId}/image?size=thumb`)).statusCode).toBe(200);
  });
});
