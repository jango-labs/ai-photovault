import { memo, useState, type MouseEvent } from 'react';
import { cx } from '../lib/cx';
import { Icon } from './Icon';
import { InstagramStatus, PortfolioMark } from './status';
import { StarRating } from './StarRating';
import { Hairline } from './feedback';
import type { PhotoItem } from './photo';

export type OverlayMode = 'hover' | 'always' | 'none';

export interface ThumbnailProps {
  photo: PhotoItem; index: number; domId: string; width: number; height: number;
  selected: boolean; active: boolean; showScore?: boolean;
  onPick: (index: number, e: MouseEvent) => void; onOpen: (index: number) => void; onToggle: (index: number) => void;
}

const IG_DOT: Record<string, string> = { POSTED: 'var(--mist)', SCHEDULED: 'var(--aqua)', DRAFT: 'var(--text-2)', FAILED: 'var(--danger)' };

/**
 * One photograph in the contact sheet. Image first: the photograph is shown uncropped to its own aspect ratio and is never tinted.
 * Chrome (checkbox, rating, flags) appears on hover / focus / selection (or always, per grid setting).
 * Persistent signals are limited to a 6px Instagram dot and a 3px bar for scheduled posts.
 */
export const Thumbnail = memo(function Thumbnail({ photo, index, domId, width, height, selected, active, showScore, onPick, onOpen, onToggle }: ThumbnailProps) {
  const [broken, setBroken] = useState(false);
  const dup = !!photo.possibleDuplicate && photo.ig.state === 'NEVER_POSTED';
  const label = `${photo.title}${photo.rating ? `, rated ${photo.rating} of 5` : ''}${photo.favorite ? ', favourite' : ''}${photo.portfolio ? ', portfolio candidate' : ''}${photo.ig.state !== 'NEVER_POSTED' ? `, Instagram ${photo.ig.state.toLowerCase()}` : ''}${dup ? ', possibly already on Instagram' : ''}${photo.duplicateCandidate ? ', similar to another photograph' : ''}`;
  return (
    <div id={domId} role="option" aria-selected={selected} aria-label={label} data-active={active || undefined} data-index={index}
      className={cx('jb-thumb', photo.hidden && 'jb-thumb--hidden')} style={{ width, height, flex: 'none', ...(photo.dominant ? { background: photo.dominant } : {}) }}
      onClick={(e) => onPick(index, e)} onDoubleClick={() => onOpen(index)}>
      {broken
        ? <span className="jb-thumb__nopreview" aria-hidden><Icon name="image" size={18} /></span>
        : <img src={photo.src} alt="" width={photo.width} height={photo.height} loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />}
      {photo.processing && photo.processing !== 'done' && <div className="jb-thumb__proc"><Hairline staticOnly={photo.processing === 'queued'} label={photo.processing} /></div>}
      {photo.ig.state !== 'NEVER_POSTED' && <span className="jb-thumb__igdot" style={{ background: IG_DOT[photo.ig.state] }} aria-hidden />}
      {dup && <span className="jb-thumb__igdot jb-thumb__igdot--possible" aria-hidden />}
      {photo.ig.state === 'SCHEDULED' && <span className="jb-thumb__bar" aria-hidden />}
      <div className="jb-thumb__chrome" aria-hidden>
        <span className="jb-thumb__tl" style={{ pointerEvents: 'auto' }} onClick={(e) => { e.stopPropagation(); onToggle(index); }}>
          <span className="box">{selected && <Icon name="check" size={10} />}</span>
          {showScore && photo.aiScore !== undefined && <span className="t-num">{Math.round(photo.aiScore * 100)}</span>}
        </span>
        <span className="jb-thumb__tr">
          {photo.portfolio && <PortfolioMark />}
          {dup && <span className="jb-ig jb-ig--possible"><Icon name="compare" size={11} />POSSIBLE MATCH</span>}
          {photo.duplicateCandidate && <span className="jb-ig jb-ig--similar"><Icon name="compare" size={11} />SIMILAR</span>}
          <InstagramStatus state={photo.ig.state} count={photo.ig.count} />
        </span>
        {(photo.rating > 0 || photo.favorite) && (
          <span className="jb-thumb__flags">
            {photo.rating > 0 && <StarRating value={photo.rating} />}
            {photo.favorite && <span className="jb-fav" aria-pressed="true"><Icon name="heart" size={12} /></span>}
          </span>
        )}
      </div>
    </div>
  );
});
