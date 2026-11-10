import { describe, expect, it } from 'vitest';
import { resourcePressure, type PressureProbes } from '../ops/pressure.js';

describe('resource pressure (when heavy AI work must wait)', () => {
  const probes = (level: number, free: Record<string, number>): PressureProbes => ({ memoryLevel: async () => level, freeBytes: async (d) => { if (!(d in free)) throw new Error('ENOENT'); return free[d]!; } });
  const dirs = [{ label: 'the photo drive', path: '/d', minFreeGb: 20 }, { label: 'the disk that holds the database', path: '/h', minFreeGb: 10 }];
  it('is fine with normal memory and enough space', async () => { expect(await resourcePressure({ dirs, probes: probes(1, { '/d': 500e9, '/h': 40e9 }) })()).toBeNull(); });
  it('holds on memory warning or critical, and says which', async () => {
    expect(await resourcePressure({ dirs, probes: probes(2, { '/d': 500e9, '/h': 40e9 }) })()).toBe('this computer is short of memory');
    expect(await resourcePressure({ dirs, probes: probes(4, { '/d': 500e9, '/h': 40e9 }) })()).toBe('this computer is critically short of memory');
  });
  it('holds when either disk is nearly full, naming it; a missing folder is not this check\'s business', async () => {
    expect(await resourcePressure({ dirs, probes: probes(1, { '/d': 5e9, '/h': 40e9 }) })()).toBe('less than 20 GB free on the photo drive');
    expect(await resourcePressure({ dirs, probes: probes(1, { '/d': 500e9, '/h': 2e9 }) })()).toBe('less than 10 GB free on the disk that holds the database');
    expect(await resourcePressure({ dirs, probes: probes(1, { '/h': 40e9 }) })()).toBeNull();
  });
  it('caches for the configured time, then re-reads', async () => {
    let level = 1; let t = 0; const f = resourcePressure({ dirs: [], probes: { memoryLevel: async () => level, freeBytes: async () => 1e12 }, ttlMs: 10_000, now: () => t });
    expect(await f()).toBeNull(); level = 4; t = 5_000; expect(await f()).toBeNull(); t = 11_000; expect(await f()).toBe('this computer is critically short of memory');
  });
});
