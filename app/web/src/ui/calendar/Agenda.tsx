import { dayKeyInZone, formatDay, formatTime, type DayKey } from '../../lib/calendar';
import { StatusChip } from '../status';
import type { CalendarItem } from './types';

/** Phone presentation of the calendar: a chronological list (no grid, no drag). */
export function Agenda({ items, onOpen }: { items: readonly CalendarItem[]; onOpen: (id: string) => void }) {
  const groups = new Map<DayKey, CalendarItem[]>();
  for (const it of [...items].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const k = dayKeyInZone(it.scheduledAt, it.timeZone);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(it);
  }
  return (
    <div className="jb-agenda" aria-label="Publishing agenda">
      {[...groups].map(([k, list]) => (
        <section key={k} className="jb-agenda__day" aria-label={formatDay(k, { weekday: 'long', day: 'numeric', month: 'long' })}>
          <p className="label-sm t-num" style={{ paddingTop: 10 }}>{formatDay(k, { day: 'numeric', month: 'short' })}</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {list.map((it) => (
              <button key={it.id} type="button" className="jb-agenda__item" onClick={() => onOpen(it.id)}>
                <img src={it.photo.src} alt="" />
                <span style={{ display: 'grid', gap: 4 }}>
                  <span className="t-h3 t-num">{formatTime(it.scheduledAt, it.timeZone)}</span>
                  <span className="t-body">{it.label ?? it.photo.title}</span>
                </span>
                <StatusChip state={it.state} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
