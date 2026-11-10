import { useId, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';
import { addDays, dayKeyInZone, formatDay, monthGrid, moveToDay, weekDays, weekday, type DayKey } from '../../lib/calendar';
import { Icon } from '../Icon';
import { CalendarEntry } from './CalendarEntry';
import type { CalendarItem } from './types';

export interface CalendarGridProps {
  mode: 'month' | 'week';
  /** month view: year+month (0-based); week view: any day in the week */
  year: number; month: number; anchor: DayKey;
  today: DayKey;
  items: readonly CalendarItem[];
  weekStart?: 0 | 1;
  onCreate: (day: DayKey) => void;
  onOpen: (id: string) => void;
  onMove: (id: string, newIso: string) => void;
  onRequestMove: (id: string) => void;
  /** open the full list of posts for a busy day (called from the “+N” tile) */
  onOpenDay?: (day: DayKey) => void;
}

/** A month cell never grows: up to 4 tiles (a 2×2 mosaic); with more posts the 4th tile becomes “+N”. */
const MAX_TILES = 4;

/**
 * Month/week publishing calendar, exposed as a table (columns = weekdays, one cell per day). Each day has one focusable
 * "Create post" button (roving tab stop): arrow keys move between days, Home/End jump to week start/end, Enter creates a post.
 * Entries inside a cell are buttons (Tab reaches them; M opens the Move dialog; they can also be dragged to another day).
 */
export function CalendarGrid({ mode, year, month, anchor, today, items, weekStart = 1, onCreate, onOpen, onMove, onRequestMove, onOpenDay }: CalendarGridProps) {
  const days = mode === 'month' ? monthGrid(year, month, weekStart) : weekDays(anchor, weekStart).map((key) => ({ key, inMonth: true }));
  const byDay = new Map<DayKey, CalendarItem[]>();
  for (const it of items) { const k = dayKeyInZone(it.scheduledAt, it.timeZone); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(it); }
  for (const list of byDay.values()) list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const [focus, setFocus] = useState<DayKey>(days.find((d) => d.key === today)?.key ?? days[0]!.key);
  const [over, setOver] = useState<DayKey | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const idBase = useId().replace(/:/g, '');
  const byId = new Map(items.map((i) => [i.id, i]));
  const head = weekDays(days[0]!.key, weekStart);

  const focusDay = (k: DayKey) => { setFocus(k); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-add="${k}"]`)?.focus()); };
  const onKey = (e: KeyboardEvent, k: DayKey) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 7 : e.key === 'ArrowUp' ? -7 : 0;
    if (delta) { e.preventDefault(); const n = addDays(k, delta); if (days.some((d) => d.key === n)) focusDay(n); }
    else if (e.key === 'Home') { e.preventDefault(); focusDay(addDays(k, -((weekday(k) - weekStart + 7) % 7))); }
    else if (e.key === 'End') { e.preventDefault(); focusDay(addDays(k, 6 - ((weekday(k) - weekStart + 7) % 7))); }
  };
  const drop = (e: DragEvent, k: DayKey) => {
    e.preventDefault(); setOver(null);
    const it = byId.get(e.dataTransfer.getData('text/plain'));
    if (it && dayKeyInZone(it.scheduledAt, it.timeZone) !== k) onMove(it.id, moveToDay(it.scheduledAt, it.timeZone, k));
  };

  return (
    <div className={cx('jb-cal', mode === 'week' && 'jb-cal--week')} ref={root}>
      <div className="jb-cal__grid" role="table" aria-label={mode === 'month' ? 'Publishing calendar, month' : 'Publishing calendar, week'}>
        <div role="row" style={{ display: 'contents' }}>
          {head.map((k) => <span key={k} role="columnheader" className="label-sm" aria-label={formatDay(k, { weekday: 'long' })}>{formatDay(k, { weekday: 'short' })}</span>)}
        </div>
        {Array.from({ length: days.length / 7 }, (_, w) => (
          <div key={w} role="row" style={{ display: 'contents' }}>
            {days.slice(w * 7, w * 7 + 7).map(({ key, inMonth }) => {
              const list = byDay.get(key) ?? [];
              const overflow = mode === 'month' && list.length > MAX_TILES;
              const shown = overflow ? list.slice(0, MAX_TILES - 1) : list;
              const slots = overflow ? MAX_TILES : Math.min(list.length, MAX_TILES);
              const dayNum = Number(key.slice(8));
              return (
                <div key={key} role="cell" className="jb-cal__day" data-day={key} data-today={key === today} data-outside={!inMonth} data-drop={over === key || undefined}
                  aria-labelledby={`${idBase}-d-${key}`}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== key) setOver(key); }} onDragLeave={() => setOver((o) => (o === key ? null : o))} onDrop={(e) => drop(e, key)}>
                  <div className="jb-cal__date">
                    <span id={`${idBase}-d-${key}`}><span className="jb-sr-only">{formatDay(key, { weekday: 'long' })} </span>{mode === 'week' ? formatDay(key, { weekday: 'short', day: 'numeric' }) : dayNum}<span className="jb-sr-only"> {formatDay(key, { month: 'long' })}{list.length ? `, ${list.length} post${list.length > 1 ? 's' : ''}` : ''}</span></span>
                    <button type="button" className="jb-btn jb-btn--icon jb-btn--sm jb-cal__add" data-add={key} aria-label={`Create post on ${formatDay(key, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                      tabIndex={key === focus ? 0 : -1} onFocus={() => setFocus(key)} onKeyDown={(e) => onKey(e, key)} onClick={() => onCreate(key)}><Icon name="plus" size={12} /></button>
                  </div>
                  <div className="jb-cal__entries" data-n={mode === 'month' ? slots : 1}>
                    {shown.map((it) => <CalendarEntry key={it.id} item={it} compact={mode === 'month' && slots > 1} onOpen={onOpen} onRequestMove={onRequestMove} />)}
                    {overflow && (
                      <button type="button" className="jb-entry jb-entry--more" onClick={() => onOpenDay?.(key)}>
                        <span className="t-num">+{list.length - shown.length}</span> <span className="label-sm">more</span><span className="visually-hidden"> posts. Show all {list.length} posts on {formatDay(key, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
