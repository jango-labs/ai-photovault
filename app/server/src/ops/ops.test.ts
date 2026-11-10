import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dirUsage } from './storage.js';
import { DEFAULT_POLICY, planRetention, type BackupFile } from './retention.js';

const NOW = new Date('2026-10-09T12:00:00Z'); const H = 3_600_000, D = 24 * H;
const at = (hoursAgo: number, verified = true): BackupFile => ({ name: `b-${hoursAgo}h${verified ? '' : '-u'}`, at: new Date(NOW.getTime() - hoursAgo * H), verified });
const every6h = (days: number, verified = true) => Array.from({ length: days * 4 }, (_, i) => at(i * 6, verified));

describe('backup retention', () => {
  it('thins a year of 6-hourly backups to 4/day for 3 days, 1/day to 14 days, 1/week to 8 weeks, 1/month to 12 months', () => {
    const files = every6h(400); const { keep } = planRetention(files, NOW); const kept = files.filter((f) => keep.includes(f.name));
    const ageD = (f: BackupFile) => (NOW.getTime() - f.at.getTime()) / D;
    expect(kept.filter((f) => ageD(f) <= 3).length).toBeGreaterThanOrEqual(12); expect(kept.length).toBeLessThan(60);
    const days = (lo: number, hi: number) => new Set(kept.filter((f) => ageD(f) > lo && ageD(f) <= hi).map((f) => f.at.toISOString().slice(0, 10)));
    expect(kept.filter((f) => ageD(f) > 3 && ageD(f) <= 14).length).toBe(days(3, 14).size);              // exactly one per day in that range
    expect(kept.filter((f) => ageD(f) > 40 && ageD(f) <= 56).length).toBeLessThanOrEqual(3);
    expect(kept.filter((f) => ageD(f) > 330 && ageD(f) <= 400).length).toBeLessThanOrEqual(2);
  });
  it('never deletes the newest verified backup, even when it is old and newer ones are unverified', () => {
    const files = [at(2, false), at(5, false), at(24 * 40, true), at(24 * 41, true)]; const { keep, remove } = planRetention(files, NOW);
    expect(keep).toContain('b-960h'); expect(remove).not.toContain('b-960h');
  });
  it('never ends up with nothing: a lone unverified backup is kept however old', () => {
    expect(planRetention([at(24 * 60, false)], NOW).keep).toEqual(['b-1440h-u']); expect(planRetention([], NOW)).toEqual({ keep: [], remove: [] });
  });
  it('unverified backups are given a week of grace and then dropped (while a verified one exists)', () => {
    const { keep, remove } = planRetention([at(1), at(24 * 2, false), at(24 * 9, false)], NOW); expect(keep).toContain('b-48h-u'); expect(remove).toContain('b-216h-u');
  });
  it('keeps the newest per bucket (not the oldest), and removes everything it does not keep', () => {
    const files = [at(1), at(3), at(5), at(7), at(9), at(11)]; const { keep, remove } = planRetention(files, NOW, { ...DEFAULT_POLICY, perDayRecent: 2 });
    expect(keep.slice(0, 2)).toEqual(['b-1h', 'b-3h']); expect(new Set([...keep, ...remove]).size).toBe(files.length); expect(keep.filter((k) => remove.includes(k))).toEqual([]);
  });
  it('is idempotent: applying the plan and planning again removes nothing more', () => {
    const files = every6h(120); const first = planRetention(files, NOW); const again = planRetention(files.filter((f) => first.keep.includes(f.name)), NOW); expect(again.remove).toEqual([]);
  });
});

describe('directory usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-du-')); afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  it('sums bytes and files recursively, tolerates a missing folder, and says when it stopped early', async () => {
    fs.mkdirSync(path.join(root, 'a/b'), { recursive: true }); fs.writeFileSync(path.join(root, 'x'), Buffer.alloc(1000)); fs.writeFileSync(path.join(root, 'a/y'), Buffer.alloc(500)); fs.writeFileSync(path.join(root, 'a/b/z'), Buffer.alloc(24));
    expect(await dirUsage(root)).toEqual({ bytes: 1524, files: 3, truncated: false }); expect(await dirUsage(path.join(root, 'nope'))).toEqual({ bytes: 0, files: 0, truncated: false });
    expect((await dirUsage(root, Date.now() - 1)).truncated).toBe(true);
  });
});
