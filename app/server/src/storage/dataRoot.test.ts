import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DataRoot, MARKER, StorageUnavailableError, dataRootFromEnv, type VolumeInfo } from './dataRoot.js';

const UUID = '3E1F6D2A-0B4C-4E8A-9C11-7A5B2D9F0E44';
const dirs: string[] = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-dr-'))); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
// the temporary folders stand in for a mounted drive; the boot device is faked so the "different device" rule can be tested on one disk
const drive = (mount: string, o: Partial<VolumeInfo> = {}) => async (uuid: string): Promise<VolumeInfo | null> => (uuid.toUpperCase() === UUID ? { uuid, mountPoint: mount, writable: true, ...o } : null);
const mk = (mount: string, marker: unknown = { version: 1, storageId: UUID }) => { const root = path.join(mount, 'PhotoVaultData'); fs.mkdirSync(root); if (marker) fs.writeFileSync(path.join(root, MARKER), JSON.stringify(marker)); return root; };
const make = (probe: ReturnType<typeof drive>, boot = -1) => new DataRoot({ storageId: UUID, probe, ttlMs: 0, bootDevice: async () => boot });

describe('data root identified by a storage id', () => {
  it('is ready only when the drive is attached, writable, on another device, and the data folder carries this drive\'s marker', async () => {
    const m = tmp(); const root = mk(m); const dr = make(drive(m));
    expect(await dr.status()).toMatchObject({ ready: true, reason: null, root, mountPoint: m });
    expect(await dr.dir('derivatives')).toBe(path.join(root, 'derivatives')); expect(await dr.dir('ai-assets')).toBe(path.join(root, 'ai-assets')); expect(await dr.gate()).toBeNull();
  });
  it('the mount path does not matter: the same drive mounted somewhere else is found by its UUID', async () => {
    const a = tmp(), b = tmp(); mk(a); mk(b);
    expect((await make(drive(a)).status()).root).toBe(path.join(a, 'PhotoVaultData')); expect((await make(drive(b)).status()).root).toBe(path.join(b, 'PhotoVaultData'));
  });
  it('is unavailable — with a plain reason — when the drive is missing, unmounted, read-only, or the folder is not what it should be', async () => {
    const m = tmp(); mk(m);
    expect((await make(async () => null).status())).toMatchObject({ ready: false, reason: 'the drive is not connected', root: null });
    expect((await make(drive(m, { mountPoint: null })).status()).reason).toBe('the drive is connected but not mounted');
    expect((await make(drive(m, { writable: false })).status()).reason).toBe('the drive is mounted read-only');
    const bare = tmp(); expect((await make(drive(bare)).status()).reason).toMatch(/does not exist on the drive/);
    const nomark = tmp(); mk(nomark, null); expect((await make(drive(nomark)).status()).reason).toMatch(/no valid marker/);
    const other = tmp(); mk(other, { version: 1, storageId: 'AAAAAAAA-0B4C-4E8A-9C11-7A5B2D9F0E44' }); expect((await make(drive(other)).status()).reason).toMatch(/different drive/);
    const junk = tmp(); mk(junk, 'not an object'); expect((await make(drive(junk)).status()).reason).toBeTruthy();
  });
  it('refuses a mount folder that lives on the internal (boot) device, as macOS leaves behind when a drive is unplugged', async () => {
    const m = tmp(); mk(m); const boot = fs.statSync(m).dev;
    expect((await make(drive(m), boot).status()).reason).toMatch(/internal disk/);
  });
  it('require() throws StorageUnavailableError while unavailable, and recovers when the drive returns', async () => {
    const m = tmp(); mk(m); let attached = false;
    const dr = make(async (u) => (attached ? drive(m)(u) : null));
    await expect(dr.require()).rejects.toBeInstanceOf(StorageUnavailableError); expect(await dr.gate()).toBe('the drive is not connected');
    attached = true; expect(await dr.require()).toBe(path.join(m, 'PhotoVaultData'));
  });
  it('caches briefly, and validates its inputs', async () => {
    const m = tmp(); mk(m); let calls = 0; let t = 0;
    const dr = new DataRoot({ storageId: UUID, ttlMs: 1000, now: () => t, bootDevice: async () => -1, probe: async (u) => { calls++; return drive(m)(u); } });
    await dr.status(); await dr.status(); expect(calls).toBe(1); t = 2000; await dr.status(); expect(calls).toBe(2); await dr.status(true); expect(calls).toBe(3);
    expect(() => new DataRoot({ storageId: 'nope' })).toThrow(/STORAGE_ID/); expect(() => new DataRoot({ storageId: UUID, subdir: '../x' })).toThrow(/relative/); expect(() => new DataRoot({ storageId: UUID, subdir: '/abs' })).toThrow(/relative/);
    expect(dataRootFromEnv({})).toBeNull(); expect(dataRootFromEnv({ PHOTOVAULT_STORAGE_ID: UUID, PHOTOVAULT_STORAGE_MOUNT: '/tmp', PHOTOVAULT_DATA_SUBDIR: 'X' })).toBeInstanceOf(DataRoot);
  });
});
