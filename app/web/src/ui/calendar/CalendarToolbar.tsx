import { IconButton } from '../Button';
import { SegmentedControl } from '../controls';
import { Button } from '../Button';
import { H2 } from '../typography';

export function CalendarToolbar({ title, mode, onMode, onPrev, onNext, onToday, level = 2 }: {
  level?: 2 | 3; title: string; mode: 'month' | 'week'; onMode: (m: 'month' | 'week') => void; onPrev: () => void; onNext: () => void; onToday: () => void;
}) {
  return (
    <div className="jb-row" style={{ justifyContent: 'space-between' }}>
      <div className="jb-row" style={{ gap: 8 }}>
        <IconButton icon="chevronLeft" label={mode === 'month' ? 'Previous month' : 'Previous week'} onClick={onPrev} />
        <IconButton icon="chevronRight" label={mode === 'month' ? 'Next month' : 'Next week'} onClick={onNext} />
        <Button variant="ghost" onClick={onToday}>Today</Button>
        <H2 as={`h${level}`}>{title}</H2>
      </div>
      <SegmentedControl label="Calendar view" value={mode} onChange={onMode} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
    </div>
  );
}
