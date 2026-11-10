import { useEffect, useState } from 'react';
import { dayKeyInZone, formatTime, zonedToIso } from '../../lib/calendar';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import type { CalendarItem } from './types';

/** Non-drag way to reschedule: pick a date and time. Time zone is shown, never silently changed. */
export function MoveDialog({ item, onClose, onMove }: { item: CalendarItem | null; onClose: () => void; onMove: (id: string, iso: string) => void }) {
  const [date, setDate] = useState(''); const [time, setTime] = useState('');
  useEffect(() => { if (item) { setDate(dayKeyInZone(item.scheduledAt, item.timeZone)); setTime(formatTime(item.scheduledAt, item.timeZone)); } }, [item]);
  if (!item) return null;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Reschedule post" description={`${item.label ?? item.photo.title} — times are in ${item.timeZone}.`}
      actions={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} onClick={() => { onMove(item.id, zonedToIso(date, time, item.timeZone)); onClose(); }}>Move</Button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6 }}><span className="label-sm">Date</span>
          <span className="jb-field"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>
        <label style={{ display: 'grid', gap: 6 }}><span className="label-sm">Time ({item.timeZone})</span>
          <span className="jb-field"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></span></label>
      </div>
    </Dialog>
  );
}
