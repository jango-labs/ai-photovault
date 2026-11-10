import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnsafeLibraryRootError, assertSafeLibraryRoot, folderMetadata, isJpeg } from './guard.js';

const made: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'photovault-guard-'));
  made.push(d);
  return fs.realpathSync(d);
}
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('assertSafeLibraryRoot', () => {
  it('requires an explicit absolute path', () => {
    expect(() => assertSafeLibraryRoot(undefined)).toThrow(UnsafeLibraryRootError);
    expect(() => assertSafeLibraryRoot('relative/FINAL')).toThrow(/absolute/);
  });
  it('refuses filesystem root, home and bare volumes', () => {
    expect(() => assertSafeLibraryRoot('/')).toThrow(/broad/);
    expect(() => assertSafeLibraryRoot(os.homedir())).toThrow(/broad/);
    expect(() => assertSafeLibraryRoot('/Volumes/Photography 1')).toThrow(/broad/);
  });
  it('accepts a tree of JPEGs', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, '2026', 'Kenya'), { recursive: true });
    fs.writeFileSync(path.join(d, '2026', 'Kenya', 'IMG_1.jpg'), 'x');
    expect(assertSafeLibraryRoot(d)).toBe(d);
  });
  it('refuses a tree containing RAW files (even nested)', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, '2025', 'Kenya'), { recursive: true });
    fs.writeFileSync(path.join(d, '2025', 'Kenya', 'DSC_0001.NEF'), 'x');
    expect(() => assertSafeLibraryRoot(d)).toThrow(/RAW/);
  });
  it('refuses Lightroom catalog artefacts', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'Lightroom Catalog.lrcat'), 'x');
    expect(() => assertSafeLibraryRoot(d)).toThrow(/catalog/);
  });
});

describe('folder metadata', () => {
  it('derives year and location from YYYY/Location/', () => {
    expect(folderMetadata('2026/Kenya/IMG_8427.jpg')).toEqual({ year: 2026, location: 'Kenya', subpath: null });
    expect(folderMetadata('2026/Kenya/Day 3/a.jpg')).toEqual({ year: 2026, location: 'Kenya', subpath: 'Day 3' });
  });
  it('returns nulls when the layout does not match', () => {
    expect(folderMetadata('misc/a.jpg')).toEqual({ year: null, location: null, subpath: null });
    expect(folderMetadata('a.jpg')).toEqual({ year: null, location: null, subpath: null });
  });
  it('recognises jpeg extensions only', () => {
    expect(isJpeg('a.JPG')).toBe(true);
    expect(isJpeg('a.jpeg')).toBe(true);
    expect(isJpeg('a.dng')).toBe(false);
  });
});
