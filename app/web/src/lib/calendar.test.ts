import { describe, expect, it } from 'vitest';
import { addDays, dayKeyInZone, formatTime, monthGrid, moveToDay, weekDays, weekday, zonedToIso } from './calendar';

describe('calendar math', () => {
  it('month grid is always 6×7 and starts on the chosen weekday', () => {
    for (const [y, m] of [[2026, 1], [2026, 9], [2024, 1], [2027, 11]] as const) {
      const g = monthGrid(y, m, 1);
      expect(g).toHaveLength(42);
      expect(weekday(g[0]!.key)).toBe(1);
      expect(g.filter((d) => d.inMonth).length).toBe(new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
    }
    expect(weekday(monthGrid(2026, 9, 0)[0]!.key)).toBe(0);
  });
  it('week days are 7 consecutive days containing the anchor', () => {
    const w = weekDays('2026-10-08', 1);
    expect(w).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  });
  it('addDays crosses month and year boundaries and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('assigns an instant to the calendar day of its own time zone', () => {
    const iso = '2026-10-08T23:30:00Z';
    expect(dayKeyInZone(iso, 'UTC')).toBe('2026-10-08');
    expect(dayKeyInZone(iso, 'Asia/Tokyo')).toBe('2026-10-09');
    expect(dayKeyInZone(iso, 'America/Los_Angeles')).toBe('2026-10-08');
  });
  it('moving a post keeps its local wall-clock time, across a DST change', () => {
    const before = zonedToIso('2026-03-27', '19:30', 'Europe/London');       // GMT
    expect(before).toBe('2026-03-27T19:30:00.000Z');
    const after = moveToDay(before, 'Europe/London', '2026-03-30');          // BST begins 29 Mar
    expect(formatTime(after, 'Europe/London')).toBe('19:30');
    expect(after).toBe('2026-03-30T18:30:00.000Z');
  });
  it('a nonexistent local time (spring-forward gap) resolves forward, never to the wrong day', () => {
    const iso = zonedToIso('2026-03-29', '01:30', 'Europe/London');           // 01:30 does not exist
    expect(dayKeyInZone(iso, 'Europe/London')).toBe('2026-03-29');
    expect(formatTime(iso, 'Europe/London')).toMatch(/^0[12]:30$/);
  });
  it('round-trips wall-clock times in far-away zones', () => {
    for (const tz of ['Asia/Kolkata', 'Pacific/Auckland', 'America/New_York']) {
      const iso = zonedToIso('2026-10-08', '07:45', tz);
      expect(formatTime(iso, tz)).toBe('07:45'); expect(dayKeyInZone(iso, tz)).toBe('2026-10-08');
    }
  });
});
