import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { zonedToIso } from '../../lib/calendar';
import { CalendarGrid } from './CalendarGrid';
import type { CalendarItem } from './types';

const tz = 'Europe/London', today = '2026-10-08';
const many = (n: number, day = '2026-10-14'): CalendarItem[] => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, photo: { src: '/fixtures/p01.jpg', alt: 'Synthetic', title: `Post ${i}` }, label: `Post ${i}`, timeZone: tz, state: i % 3 ? 'DRAFT' : 'SCHEDULED', scheduledAt: zonedToIso(day, `${String(7 + i).padStart(2, '0')}:00`, tz),
}));
const base = { mode: 'month' as const, year: 2026, month: 9, anchor: today, today, weekStart: 1 as const, onCreate: vi.fn(), onOpen: vi.fn(), onMove: vi.fn(), onRequestMove: vi.fn() };
const cell = (day: string) => document.querySelector<HTMLElement>(`[data-day="${day}"]`)!;
const css = fs.readFileSync(path.join(__dirname, '../../styles/ui.css'), 'utf8');

describe('calendar: many posts per day without tall rows', () => {
  it.each([1, 2, 3, 4])('%i post(s) are shown as tiles, none hidden', (n) => {
    render(<CalendarGrid {...base} items={many(n)} />);
    expect(cell('2026-10-14').querySelectorAll('.jb-entry:not(.jb-entry--more)')).toHaveLength(n);
    expect(cell('2026-10-14').querySelector('.jb-entry--more')).toBeNull();
    expect(cell('2026-10-14').querySelector('.jb-cal__entries')!.getAttribute('data-n')).toBe(String(n));
  });
  it('more than four posts collapse into three tiles plus a “+N” tile (so the cell never grows)', () => {
    const onOpenDay = vi.fn();
    render(<CalendarGrid {...base} items={many(9)} onOpenDay={onOpenDay} />);
    const c = cell('2026-10-14');
    expect(c.querySelectorAll('.jb-entry:not(.jb-entry--more)')).toHaveLength(3);
    const more = within(c).getByRole('button', { name: /Show all 9 posts on Wednesday 14 October/ });
    expect(more.textContent).toContain('+6');
    expect(c.querySelector('.jb-cal__entries')!.getAttribute('data-n')).toBe('4');
    fireEvent.click(more); expect(onOpenDay).toHaveBeenCalledWith('2026-10-14');
  });
  it('a busy day has exactly the same footprint rule as an empty one (all cells share one fixed height)', () => {
    const { rerender } = render(<CalendarGrid {...base} items={[]} />);
    const empty = [...document.querySelectorAll('.jb-cal__day')].length;
    rerender(<CalendarGrid {...base} items={many(12)} />);
    expect(document.querySelectorAll('.jb-cal__day')).toHaveLength(empty);
    const rule = css.match(/\.jb-cal__day \{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/height:\s*var\(--cal-day-h\)/); expect(rule).toMatch(/overflow:\s*hidden/); expect(rule).not.toMatch(/min-height/);
    expect(css).toMatch(/\.jb-cal \{ --cal-day-h: clamp\(140px, 11vw, 188px\); \}/);                 // roughly 1.2–1.7 inches: far below the old 290 px rows
  });
  it('week view lists every post (the column scrolls instead of truncating)', () => {
    render(<CalendarGrid {...base} mode="week" anchor="2026-10-14" items={many(9)} />);
    expect(cell('2026-10-14').querySelectorAll('.jb-entry')).toHaveLength(9);
    expect(css).toMatch(/\.jb-cal--week \.jb-cal__day \{ overflow-y: auto; \}/);
  });
  it('compact tiles keep time, state glyph and an accessible name; the busy grid is accessible', async () => {
    const { container } = render(<CalendarGrid {...base} items={many(4)} />);
    const tile = cell('2026-10-14').querySelector<HTMLElement>('.jb-entry')!;
    expect(tile.getAttribute('aria-label')).toMatch(/^07:00 Post 0 SCHEDULED/); expect(tile.querySelector('svg')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});
