import { describe, expect, it } from 'vitest';
import { fmtCapture } from './photoMap';

describe('capture dates are shown on the camera\'s own clock', () => {
  it('moves the stored instant by the capture offset, so a late-evening shot keeps its own date', () => {
    expect(fmtCapture('2026-01-01T06:30:00.100Z', '-07:00')).toBe('31 December 2025');   // 23:30 on 31 December in Montana
    expect(fmtCapture('2025-12-31T15:10:00.200Z', '+09:00')).toBe('1 January 2026');      // 00:10 on 1 January in Tokyo
    expect(fmtCapture('2022-05-06T11:42:11.000Z', '+05:30')).toBe('6 May 2022');
  });
  it('reads a time without a known offset as written', () => { expect(fmtCapture('2026-03-03T10:00:00.300Z', null)).toBe('3 March 2026'); expect(fmtCapture('2026-03-03T23:59:00.000Z', undefined)).toBe('3 March 2026'); });
});
