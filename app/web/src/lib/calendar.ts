/** Date helpers for the publishing calendar. Days are keyed 'YYYY-MM-DD' in the entry's own IANA time zone. */
export type DayKey = string;

export function pad(n: number): string { return String(n).padStart(2, '0'); }
export const dayKey = (y: number, m: number, d: number): DayKey => `${y}-${pad(m + 1)}-${pad(d)}`;

export function parseDayKey(k: DayKey): { y: number; m: number; d: number } {
  const [y, m, d] = k.split('-').map(Number) as [number, number, number];
  return { y, m: m - 1, d };
}

/** UTC-based day arithmetic (no DST surprises: day keys are calendar dates, not instants). */
export function addDays(k: DayKey, n: number): DayKey {
  const { y, m, d } = parseDayKey(k);
  const t = new Date(Date.UTC(y, m, d + n));
  return dayKey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

export function weekday(k: DayKey): number {
  const { y, m, d } = parseDayKey(k);
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

export interface GridDay { key: DayKey; inMonth: boolean }

/** Always 6 rows × 7 columns so the grid never changes height between months. */
export function monthGrid(year: number, month: number, weekStart: 0 | 1 = 1): GridDay[] {
  const first = dayKey(year, month, 1);
  const lead = (weekday(first) - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const out: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const key = addDays(start, i);
    out.push({ key, inMonth: parseDayKey(key).m === month });
  }
  return out;
}

export function weekDays(anchor: DayKey, weekStart: 0 | 1 = 1): DayKey[] {
  const lead = (weekday(anchor) - weekStart + 7) % 7;
  const start = addDays(anchor, -lead);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The calendar day an instant falls on in the given IANA zone. */
export function dayKeyInZone(iso: string, timeZone: string): DayKey {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function formatTime(iso: string, timeZone: string, hour12 = false): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12 }).format(new Date(iso));
}

export function formatDay(k: DayKey, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const { y, m, d } = parseDayKey(k);
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m, d)));
}

export function monthTitle(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 1)));
}

/**
 * Moves an entry to another calendar day keeping its local wall-clock time in its own zone.
 * Returns an ISO instant. (Nonexistent/ambiguous DST times are resolved forward by one hour, never silently dropped.)
 */
export function moveToDay(iso: string, timeZone: string, target: DayKey): string {
  const time = formatTime(iso, timeZone);
  return zonedToIso(target, time, timeZone);
}

export function zonedToIso(day: DayKey, hhmm: string, timeZone: string): string {
  const { y, m, d } = parseDayKey(day);
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  let guess = Date.UTC(y, m, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const asZone = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(guess)).replace(' ', 'T') + 'Z').getTime();
    const wanted = Date.UTC(y, m, d, hh, mm);
    guess += wanted - asZone;
  }
  // A local time inside a spring-forward gap does not exist; resolve it forward by the missing hour (never backward, never dropped).
  const back = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(guess)).replace(' ', 'T') + ':00Z').getTime();
  if (back !== Date.UTC(y, m, d, hh, mm)) guess += 3600_000;
  return new Date(guess).toISOString();
}
