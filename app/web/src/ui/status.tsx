import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

/** Publishing lifecycle (calendar, drafts, schedule). Colour is never the only signal: every state has a glyph and a word. */
export type PublishState = 'DRAFT' | 'READY' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';
export const PUBLISH_STATES: readonly PublishState[] = ['DRAFT', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'];
const PUBLISH_ICON: Record<PublishState, IconName> = { DRAFT: 'post', READY: 'check', SCHEDULED: 'clock', PUBLISHING: 'send', PUBLISHED: 'check', FAILED: 'alert', CANCELLED: 'close' };

export function StatusChip({ state, compact }: { state: PublishState; compact?: boolean }) {
  return (
    <span className={cx('jb-status', `jb-status--${state.toLowerCase()}`)} data-state={state}>
      <Icon name={PUBLISH_ICON[state]} size={10} />{compact ? <span className="jb-sr-only">{state}</span> : state}
    </span>
  );
}

/** A photograph's relationship to Instagram. NEVER_POSTED is deliberately silent in dense views (absence is the default). */
export type InstagramState = 'NEVER_POSTED' | 'POSTED' | 'DRAFT' | 'SCHEDULED' | 'FAILED';
export function InstagramStatus({ state, count, showNever }: { state: InstagramState; count?: number; showNever?: boolean }) {
  if (state === 'NEVER_POSTED') return showNever ? <span className="jb-ig" style={{ color: 'var(--text-3)' }}>NEVER POSTED</span> : null;
  const text = state === 'POSTED' ? (count && count > 1 ? `POSTED ×${count}` : 'POSTED') : state;
  return (
    <span className={cx('jb-ig', state === 'SCHEDULED' && 'jb-ig--scheduled', state === 'DRAFT' && 'jb-ig--draft', state === 'FAILED' && 'jb-ig--failed')}
      data-state={state}>
      <Icon name={state === 'SCHEDULED' ? 'clock' : state === 'FAILED' ? 'alert' : 'post'} size={11} />{text}
    </span>
  );
}

export type MatchState = 'EXACT_MATCH' | 'HIGH_CONFIDENCE_MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH' | 'USER_CONFIRMED' | 'USER_REJECTED';
const MATCH: Record<MatchState, { text: string; cls: string; icon: IconName }> = {
  EXACT_MATCH: { text: 'Exact match', cls: 'jb-status--ok', icon: 'check' },
  HIGH_CONFIDENCE_MATCH: { text: 'High confidence', cls: 'jb-status--ok', icon: 'check' },
  POSSIBLE_MATCH: { text: 'Review', cls: 'jb-status--warn', icon: 'compare' },
  NO_MATCH: { text: 'No match', cls: 'jb-status--draft', icon: 'close' },
  USER_CONFIRMED: { text: 'Confirmed', cls: 'jb-status--published', icon: 'check' },
  USER_REJECTED: { text: 'Rejected', cls: 'jb-status--cancelled', icon: 'close' },
};
export function MatchBadge({ state, similarity }: { state: MatchState; similarity?: number }) {
  const m = MATCH[state];
  return <span className={cx('jb-status', m.cls)} data-state={state}><Icon name={m.icon} size={10} />{m.text}{similarity !== undefined && <span className="t-num"> {Math.round(similarity * 100)}%</span>}</span>;
}

export const AiTag = () => <span className="jb-ai-tag" title="Inferred by AI; not verified">AI</span>;

/** Confidence for an AI-inferred value. Always shows the number as text as well (not colour/bars alone). */
export function ConfidenceMeter({ value, label }: { value: number; label?: string }) {
  const level = value >= 0.85 ? 'high' : value >= 0.6 ? 'mid' : 'low';
  const on = level === 'high' ? 3 : level === 'mid' ? 2 : 1;
  return (
    <span className="jb-conf" data-level={level} role="img" aria-label={`${label ? label + ': ' : ''}AI confidence ${Math.round(value * 100)} percent (${level})`}>
      <span className="jb-conf__bar" aria-hidden>{[0, 1, 2].map((i) => <i key={i} className={i < on ? 'on' : ''} />)}</span>
      <span className="t-num" aria-hidden>{Math.round(value * 100)}%</span>
    </span>
  );
}

export const PortfolioMark = () => <span className="jb-portfolio" title="Portfolio candidate" role="img" aria-label="Portfolio candidate"><Icon name="pin" size={12} /></span>;
