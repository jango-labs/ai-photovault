import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { PUB_KEY, cancelSchedule, fetchCalendar, reschedule, type CalendarEntry } from '../api/publishing';
import { imageUrl } from '../api/library';
import { addDays, dayKeyInZone, formatDay, monthGrid, monthTitle, parseDayKey, weekDays, type DayKey } from '../lib/calendar';
import { useMediaQuery } from '../lib/hooks';
import { PageHeader } from '../shell/PageHeader';
import { Button, LinkButton } from '../ui/Button';
import { Agenda } from '../ui/calendar/Agenda';
import { CalendarGrid } from '../ui/calendar/CalendarGrid';
import { CalendarToolbar } from '../ui/calendar/CalendarToolbar';
import { MoveDialog } from '../ui/calendar/MoveDialog';
import type { CalendarItem } from '../ui/calendar/types';
import { ErrorState, useToast } from '../ui/feedback';
import { SidePanel } from '../ui/SidePanel';
import { Icon } from '../ui/Icon';
import { StatusChip, type PublishState } from '../ui/status';
import { Meta } from '../ui/typography';

const STATES = new Set<string>(['DRAFT', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED']);
const toItem = (e: CalendarEntry): CalendarItem => ({
  id: e.id, photo: { src: imageUrl(e.photoId, 'thumb'), alt: e.title, title: e.title }, scheduledAt: e.scheduledAt, timeZone: e.timezone, state: (STATES.has(e.state) ? e.state : 'SCHEDULED') as PublishState, label: e.title, ...(e.error ? { error: e.error } : {}),
});

export function PublishCalendarPage() {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const today = useMemo(() => dayKeyInZone(new Date().toISOString(), tz), [tz]);
  const [mode, setMode] = useState<'month' | 'week'>('month'); const [anchor, setAnchor] = useState<DayKey>(today);
  const [open, setOpen] = useState<CalendarEntry | null>(null); const [moving, setMoving] = useState<CalendarItem | null>(null); const [dayList, setDayList] = useState<DayKey | null>(null);
  const compact = useMediaQuery('(max-width: 899px)');
  const qc = useQueryClient(); const toast = useToast(); const go = useNavigate();
  const { y, m } = parseDayKey(anchor);
  const days = mode === 'month' ? monthGrid(y, m, 1).map((d) => d.key) : weekDays(anchor, 1);
  const from = days[0]!, to = days[days.length - 1]!;
  const cal = useQuery({ queryKey: [...PUB_KEY, 'calendar', from, to], queryFn: () => fetchCalendar(from, to), staleTime: 10_000, retry: false });
  const entries = cal.data?.items ?? []; const items = useMemo(() => entries.map(toItem), [entries]);
  const byId = (id: string) => entries.find((e) => e.id === id) ?? null;
  const refresh = () => { void qc.invalidateQueries({ queryKey: PUB_KEY }); };
  const shift = (d: number) => setAnchor((a) => { if (mode === 'week') return addDays(a, 7 * d); const p = parseDayKey(a); const t = new Date(Date.UTC(p.y, p.m + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01`; });
  const fail = (what: string, e: unknown) => toast({ kind: 'error', title: `${what} failed`, body: e instanceof ApiError ? e.message : 'Nothing was changed.' });
  const move = (id: string, iso: string) => {
    const e = byId(id); if (!e) return;
    reschedule(id, iso, e.timezone).then(() => { refresh(); toast({ kind: 'ok', title: 'Rescheduled', body: 'The plan changed; nothing was sent to Instagram.' }); }).catch((err) => { refresh(); fail('Rescheduling', err); });
  };
  const dayItems = dayList ? items.filter((i) => dayKeyInZone(i.scheduledAt, i.timeZone) === dayList) : [];
  const failed = entries.filter((e) => e.state === 'FAILED');
  return (
    <div className="jb-page">
      <PageHeader eyebrow="Publish · Calendar" title="Calendar" lede="Plan what goes out and when. Photographs, not form rows."
        actions={<><LinkButton variant="outline" icon="post" to="/publish/history">Instagram history</LinkButton><LinkButton variant="primary" to="/publish/compose">New post</LinkButton></>} />
      <p className="jb-demo-note"><Icon name="info" size={14} />Scheduling is a plan. Nothing is sent to Instagram: no account is connected, and live publishing needs your approval first.</p>
      <div style={{ height: 12 }} />
      {failed.length > 0 && <ErrorState level={3} title={`${failed.length} post${failed.length === 1 ? '' : 's'} failed`}>Open a failed post to see why; its draft, image and schedule are preserved.</ErrorState>}
      <CalendarToolbar title={mode === 'month' ? monthTitle(y, m) : `Week of ${formatDay(from)}`} mode={mode} onMode={setMode} onPrev={() => shift(-1)} onNext={() => shift(1)} onToday={() => setAnchor(today)} />
      <div style={{ height: 12 }} />
      {cal.isError ? <ErrorState title="The calendar could not be loaded" onRetry={() => void cal.refetch()}>Nothing was changed.</ErrorState>
        : compact ? <Agenda items={items} onOpen={(id) => setOpen(byId(id))} />
        : <CalendarGrid mode={mode} year={y} month={m} anchor={anchor} today={today} items={items} onCreate={(d) => go(`/publish/compose?day=${d}`)} onOpen={(id) => setOpen(byId(id))} onMove={move} onRequestMove={(id) => setMoving(items.find((i) => i.id === id) ?? null)} onOpenDay={setDayList} />}
      <SidePanel open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.title ?? 'Post'}>
        {open && (
          <div style={{ display: 'grid', gap: 14 }}>
            <img src={imageUrl(open.photoId, 'view')} alt={open.title} style={{ width: '100%', borderRadius: 6, display: 'block' }} />
            <div className="jb-row"><StatusChip state={(STATES.has(open.state) ? open.state : 'SCHEDULED') as PublishState} /><span className="t-meta t-num">{new Date(open.scheduledAt).toLocaleString('en-GB', { timeZone: open.timezone, dateStyle: 'medium', timeStyle: 'short' })} ({open.timezone})</span></div>
            {open.caption && <p className="jb-hist__cap" style={{ whiteSpace: 'pre-wrap' }}>{open.caption}</p>}
            {open.error && <ErrorState level={3} title="Publishing failed">{open.error}. The draft, image and schedule are preserved.</ErrorState>}
            <div className="jb-row">
              <Link className="jb-btn jb-btn--primary" to={`/publish/compose?draft=${open.draftId}`}>Open composer</Link>
              {['SCHEDULED', 'FAILED'].includes(open.state) && <Button variant="outline" icon="calendar" onClick={() => { setMoving(items.find((i) => i.id === open.id) ?? null); setOpen(null); }}>{open.state === 'FAILED' ? 'Retry at…' : 'Reschedule…'}</Button>}
              {['SCHEDULED', 'FAILED'].includes(open.state) && <Button variant="ghost" onClick={() => { cancelSchedule(open.id).then(() => { refresh(); setOpen(null); toast({ kind: 'ok', title: 'Removed from the schedule', body: 'The draft is kept, ready to schedule again.' }); }).catch((e) => fail('Cancelling', e)); }}>Remove from schedule</Button>}
            </div>
          </div>)}
      </SidePanel>
      <SidePanel open={!!dayList} onOpenChange={(o) => !o && setDayList(null)} title={dayList ? formatDay(dayList, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Day'}>
        <Agenda items={dayItems} onOpen={(id) => { setDayList(null); setOpen(byId(id)); }} />
        {dayList && <div style={{ marginTop: 12 }}><LinkButton variant="outline" to={`/publish/compose?day=${dayList}`}>New post on this day</LinkButton></div>}
      </SidePanel>
      <MoveDialog item={moving} onClose={() => setMoving(null)} onMove={move} />
      <Meta>Times are shown in each post’s own time zone. Drag a post to another day to keep its time, or use Reschedule for an exact time.</Meta>
    </div>
  );
}
