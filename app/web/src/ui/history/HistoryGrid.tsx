import { memo } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../Icon';
import { MatchBadge, type MatchState } from '../status';

export interface HistoryItem {
  id: string;
  src: string;
  alt: string;
  /** ISO instant the post went live */
  postedAt: string;
  caption: string;
  hashtags: string[];
  shape?: '4:5' | '1:1';
  permalink?: string;
  /** link to the library photograph, if any, and how sure we are */
  match?: { state: MatchState; similarity?: number; photoTitle?: string };
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const formatPostDate = (iso: string) => dateFmt.format(new Date(iso));

/**
 * One Instagram post in the account archive. Image first; date, caption, hashtags, post link and the matched library
 * photograph reveal on hover/focus (always visible on touch). Never shows a match as certain unless it is exact/confirmed.
 */
export const HistoryTile = memo(function HistoryTile({ item, onOpen }: { item: HistoryItem; onOpen: (id: string) => void }) {
  const m = item.match;
  const matched = m && (m.state === 'EXACT_MATCH' || m.state === 'HIGH_CONFIDENCE_MATCH' || m.state === 'USER_CONFIRMED');
  return (
    <button type="button" className={cx('jb-hist__tile')} onClick={() => onOpen(item.id)}>
      <img src={item.src} alt={item.alt} loading="lazy" decoding="async" />
      <span className="jb-hist__corner">
        {matched && <span className="jb-pill" style={{ color: 'var(--aqua)' }}><Icon name="check" size={10} />Matched</span>}
        {m?.state === 'POSSIBLE_MATCH' && <span className="jb-pill" style={{ color: 'var(--warn)' }}><Icon name="compare" size={10} />Review</span>}
      </span>
      <span className="jb-hist__reveal">
        <span className="label-sm t-num" style={{ color: 'var(--text-2)' }}>{formatPostDate(item.postedAt)}</span>
        <span className="jb-hist__cap">{item.caption}</span>
        <span className="jb-row" style={{ gap: 8 }}>
          {item.hashtags.length > 0 && <span className="t-caption t-num">#{item.hashtags.length} hashtags</span>}
          {m && <MatchBadge state={m.state} similarity={m.similarity} />}
        </span>
      </span>
    </button>
  );
});

/** Archive grid with year dividers (newest first). Tile size via CSS variable --hist-size. */
export function HistoryGrid({ items, size = 200, onOpen, yearLevel = 2 }: { items: readonly HistoryItem[]; size?: number; onOpen: (id: string) => void; yearLevel?: 2 | 3 }) {
  const Y = `h${yearLevel}` as 'h2';
  const out: React.ReactNode[] = [];
  let year = '';
  const sorted = [...items].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const counts = new Map<string, number>();
  for (const it of sorted) counts.set(it.postedAt.slice(0, 4), (counts.get(it.postedAt.slice(0, 4)) ?? 0) + 1);
  for (const it of sorted) {
    const y = it.postedAt.slice(0, 4);
    if (y !== year) { year = y; out.push(<Y key={`y${y}`} className="jb-hist__year"><span className="t-h2 t-num">{y}</span><span className="t-meta t-num">{counts.get(y)} posts</span></Y>); }
    out.push(<HistoryTile key={it.id} item={it} onOpen={onOpen} />);
  }
  return <div className="jb-hist" style={{ ['--hist-size' as string]: `${size}px` }} role="group" aria-label="Instagram history">{out}</div>;
}
