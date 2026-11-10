/** Interactive compositions of design-system parts with SYNTHETIC data. Used by the showcase and by the not-yet-built Publish pages. */
import { useMemo, useState } from 'react';
import { addDays, dayKeyInZone, formatDay, monthTitle, parseDayKey, type DayKey } from '../lib/calendar';
import { useMediaQuery } from '../lib/hooks';
import { Button } from '../ui/Button';
import { Agenda } from '../ui/calendar/Agenda';
import { CalendarEntry } from '../ui/calendar/CalendarEntry';
import { CalendarGrid } from '../ui/calendar/CalendarGrid';
import { CalendarToolbar } from '../ui/calendar/CalendarToolbar';
import { MoveDialog } from '../ui/calendar/MoveDialog';
import type { CalendarItem } from '../ui/calendar/types';
import { Slider } from '../ui/controls';
import { ErrorState, useToast } from '../ui/feedback';
import { DuplicateWarning } from '../ui/history/DuplicateWarning';
import { HistoryGrid, formatPostDate } from '../ui/history/HistoryGrid';
import { MatchCompare } from '../ui/history/MatchCompare';
import { SidePanel } from '../ui/SidePanel';
import { StatusChip } from '../ui/status';
import { Label } from '../ui/typography';
import { makeCalendarItems, makeHistory } from './fixtures';

export function CalendarDemo({ withStates = true, busyDay = true, level = 2 }: { withStates?: boolean; busyDay?: boolean; level?: 2 | 3 }) {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const today = useMemo(() => dayKeyInZone(new Date().toISOString(), tz), [tz]);
  const initial = () => {
    const base = makeCalendarItems(today, tz);
    if (!busyDay) return base;
    // a deliberately busy day: 6 posts on one date must not make that row taller
    const extra = Array.from({ length: 5 }, (_, i): CalendarItem => ({ ...base[(i * 3 + 1) % base.length]!, id: `busy-${i}`, state: i % 2 ? 'DRAFT' : 'SCHEDULED', scheduledAt: base[3]!.scheduledAt.replace(/T\d\d/, `T${String(8 + i * 2).padStart(2, '0')}`) }));
    return [...base, ...extra];
  };
  const [mode, setMode] = useState<'month' | 'week'>(new URLSearchParams(window.location.search).get('cal') === 'week' ? 'week' : 'month');
  const [anchor, setAnchor] = useState<DayKey>(today);
  const [items, setItems] = useState<CalendarItem[]>(initial);
  const [moving, setMoving] = useState<CalendarItem | null>(() => (new URLSearchParams(window.location.search).get('move') ? initial().find((i) => i.state === 'SCHEDULED') ?? null : null));
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const [dayList, setDayList] = useState<DayKey | null>(() => (new URLSearchParams(window.location.search).get('day') ? today : null));
  const compact = useMediaQuery('(max-width: 899px)');   // phones and portrait tablets get the agenda; landscape tablets and up get the grid
  const toast = useToast();
  const { y, m } = parseDayKey(anchor);
  const move = (id: string, iso: string) => { setItems((xs) => xs.map((x) => (x.id === id ? { ...x, scheduledAt: iso } : x))); toast({ kind: 'ok', title: 'Post rescheduled', body: 'Demo only — nothing is published.' }); };
  const shift = (d: number) => setAnchor((a) => { if (mode === 'week') return addDays(a, 7 * d); const p = parseDayKey(a); const t = new Date(Date.UTC(p.y, p.m + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01`; });
  const byId = (id: string) => items.find((i) => i.id === id) ?? null;
  const dayItems = dayList ? items.filter((i) => dayKeyInZone(i.scheduledAt, i.timeZone) === dayList).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)) : [];
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <CalendarToolbar level={level} title={mode === 'month' ? monthTitle(y, m) : `Week of ${anchor}`} mode={mode} onMode={setMode} onPrev={() => shift(-1)} onNext={() => shift(1)} onToday={() => setAnchor(today)} />
      {compact ? <Agenda items={items} onOpen={(id) => setOpen(byId(id))} /> : (
        <CalendarGrid mode={mode} year={y} month={m} anchor={anchor} today={today} items={items}
          onCreate={(d) => toast({ kind: 'info', title: `Create post for ${d}`, body: 'The composer arrives in a later phase.' })}
          onOpen={(id) => setOpen(byId(id))} onMove={move} onRequestMove={(id) => setMoving(byId(id))} onOpenDay={setDayList} />
      )}
      {withStates && (
        <div className="ds__panel" style={{ display: 'grid', gap: 12 }}><Label>Entry states</Label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 8 }}>
            {(['DRAFT', 'READY', 'SCHEDULED', 'PUBLISHED', 'FAILED'] as const).map((s, i) => { const it = items.find((x) => x.state === s) ?? items[i]!; return <div key={s} style={{ display: 'grid', gridTemplateRows: '140px auto', gap: 6 }}><CalendarEntry item={{ ...it, state: s }} onOpen={() => {}} draggable={false} compact /><div><StatusChip state={s} /></div></div>; })}
          </div>
          <p className="t-caption">Failed carries a red top edge; draft is dashed; published is quiet. A month row never grows: more than four posts on a day collapse into a “+N” tile that opens the day’s list.</p>
        </div>
      )}
      <SidePanel open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.label ?? 'Post'}>
        {open && <div style={{ display: 'grid', gap: 14 }}>
          <img src={open.photo.src} alt={open.photo.alt} style={{ width: '100%', borderRadius: 6, display: 'block' }} />
          <div className="jb-row"><StatusChip state={open.state} /><span className="t-meta t-num">{new Date(open.scheduledAt).toLocaleString('en-GB', { timeZone: open.timeZone, dateStyle: 'medium', timeStyle: 'short' })}</span></div>
          {open.error && <ErrorState level={3} title="Publishing failed">{open.error}. The draft, image and schedule are preserved.</ErrorState>}
          <div className="jb-row"><Button variant="outline" icon="calendar" disabled={open.state === 'PUBLISHED'} onClick={() => { setMoving(open); setOpen(null); }}>Reschedule…</Button><Button variant="ghost">Open composer</Button></div>
        </div>}
      </SidePanel>
      <SidePanel open={!!dayList} onOpenChange={(o) => !o && setDayList(null)} title={dayList ? formatDay(dayList, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Day'}>
        <Agenda items={dayItems} onOpen={(id) => { setDayList(null); setOpen(byId(id)); }} />
      </SidePanel>
      <MoveDialog item={moving} onClose={() => setMoving(null)} onMove={move} />
    </div>
  );
}

export function HistoryDemo({ count = 60, tall = 620, level = 2 }: { count?: number; tall?: number | string; level?: 2 | 3 }) {
  const [size, setSize] = useState(190);
  const [dec, setDec] = useState('—');
  const [dupe, setDupe] = useState(true);
  const items = useMemo(() => makeHistory(count), [count]);
  const toast = useToast();
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="jb-row"><Slider label="Tile" value={size} min={120} max={320} step={10} onChange={setSize} format={(v) => `${v}px`} /></div>
      <div style={{ maxHeight: tall, overflow: 'auto', paddingRight: 4 }}><HistoryGrid yearLevel={level} items={items} size={size} onOpen={(id) => toast({ kind: 'info', title: `Open ${id}`, body: 'Post detail arrives in a later phase.' })} /></div>
      <div className="ds__panel" style={{ display: 'grid', gap: 16 }}>
        <div className="jb-row" style={{ justifyContent: 'space-between' }}><Label>Possible match review</Label><span className="t-meta">Last decision: {dec}</span></div>
        <MatchCompare instagram={{ src: '/fixtures/ig-p01.jpg', alt: 'Synthetic Instagram-style crop', postedAt: '2025-03-14T18:30:00Z', caption: 'Quiet light…' }}
          library={{ src: '/fixtures/p01.jpg', alt: 'Synthetic library image', title: 'Sample photograph', place: 'Kenya' }} similarity={0.92}
          signals={[['Visual', '94'], ['pHash distance', '6'], ['Date', 'consistent'], ['Crop', '4:5 of 3:2']]} onDecide={(d) => setDec(d)} />
      </div>
      {dupe && <DuplicateWarning kind="same" last={{ src: '/fixtures/ig-p02.jpg', alt: 'Synthetic previous post', postedAt: '2025-03-14T18:30:00Z', caption: 'Quiet light at the edge of the plain, a sample caption for the duplicate warning.' }}
        onView={() => toast({ kind: 'info', title: 'View previous post' })} onContinue={() => setDupe(false)} onCancel={() => setDupe(false)} />}
      {!dupe && <div><Button variant="outline" onClick={() => setDupe(true)}>Show duplicate warning again</Button></div>}
      <p className="t-caption">Last posted {formatPostDate('2025-03-14T18:30:00Z')} — the warning informs; it never blocks re-posting.</p>
    </div>
  );
}

export { demoReviewCount } from './demoStats';
