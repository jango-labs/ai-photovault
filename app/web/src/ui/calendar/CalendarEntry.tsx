import { memo, type DragEvent, type KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';
import { formatTime } from '../../lib/calendar';
import { Icon, type IconName } from '../Icon';
import type { PublishState } from '../status';
import { StatusChip } from '../status';
import type { CalendarItem } from './types';

const GLYPH: Record<PublishState, IconName> = { DRAFT: 'post', READY: 'check', SCHEDULED: 'clock', PUBLISHING: 'send', PUBLISHED: 'check', FAILED: 'alert', CANCELLED: 'close' };

/**
 * A scheduled/published/draft post as a photograph tile. The photograph is the dominant object; time, status and
 * species/title are a small text strip BELOW the image (never overlaid on it). Drag to another day, or press M for the
 * accessible "Move…" alternative.
 */
export const CalendarEntry = memo(function CalendarEntry({ item, compact, onOpen, onRequestMove, draggable = true }: {
  item: CalendarItem; compact?: boolean; draggable?: boolean; onOpen: (id: string) => void; onRequestMove?: (id: string) => void;
}) {
  const time = formatTime(item.scheduledAt, item.timeZone);
  const movable = draggable && item.state !== 'PUBLISHED' && item.state !== 'PUBLISHING';
  const onDragStart = (e: DragEvent) => { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; };
  const onKey = (e: KeyboardEvent) => { if ((e.key === 'm' || e.key === 'M') && movable && onRequestMove) { e.preventDefault(); onRequestMove(item.id); } };
  return (
    <button type="button" className={cx('jb-entry', compact && 'jb-entry--compact')} data-state={item.state} draggable={movable} onDragStart={movable ? onDragStart : undefined}
      onClick={() => onOpen(item.id)} onKeyDown={onKey}
      aria-label={compact ? `${time} ${item.label ?? item.photo.title} ${item.state}${item.error ? `. Error: ${item.error}` : ''}${movable ? '. Press M to move' : ''}` : undefined}>
      <span className="jb-entry__img"><img src={item.photo.src} alt="" loading="lazy" draggable={false} /></span>
      <span className="jb-entry__meta">
        <span className="t"><span>{time}</span>{item.state === 'FAILED' ? <Icon name="alert" size={11} style={{ color: 'var(--danger)' }} /> : compact ? <Icon name={GLYPH[item.state]} size={10} style={{ color: item.state === 'SCHEDULED' || item.state === 'READY' ? 'var(--aqua)' : 'var(--text-3)' }} /> : null}</span>
        {!compact && <span className="n">{item.label ?? item.photo.title}</span>}
        {!compact && <StatusChip state={item.state} />}
        {!compact && (item.error || movable) && <span className="jb-sr-only">{item.error ? `. Error: ${item.error}` : ''}{movable ? '. Press M to move' : ''}</span>}
      </span>
    </button>
  );
});
