import { useRef, type KeyboardEvent } from 'react';
import { cx } from '../lib/cx';
import { Icon } from './Icon';

/** 0–5 star rating. Interactive version is a radio group: ←/→ change, 0–5 set directly, same value again clears. */
export function StarRating({ value, onChange, label = 'Rating', large }: { value: number; onChange?: (v: number) => void; label?: string; large?: boolean }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  if (!onChange) {
    return (
      <span className={cx('jb-stars', large && 'jb-stars--lg')} role="img" aria-label={`${label}: ${value} of 5`}>
        {[1, 2, 3, 4, 5].map((n) => <span key={n} className={cx('s', n <= value && 'on')}><Icon name="star" size={large ? 16 : 12} style={n <= value ? undefined : { fill: 'none' }} /></span>)}
      </span>
    );
  }
  const key = (e: KeyboardEvent, n: number) => {
    if (/^[0-5]$/.test(e.key)) { e.preventDefault(); const v = Number(e.key); onChange(v); if (v > 0) refs.current[v - 1]?.focus(); return; }
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const v = Math.min(5, Math.max(1, n + d));
    onChange(v); refs.current[v - 1]?.focus();
  };
  return (
    <span className={cx('jb-stars', large && 'jb-stars--lg')} role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} ref={(el) => { refs.current[n - 1] = el; }} type="button" role="radio" aria-checked={n === value} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          tabIndex={n === (value || 1) ? 0 : -1} className={n <= value ? 'on' : ''} onClick={() => onChange(n === value ? 0 : n)} onKeyDown={(e) => key(e, n)}>
          <Icon name="star" size={large ? 16 : 13} style={n <= value ? undefined : { fill: 'none' }} />
        </button>
      ))}
    </span>
  );
}

export function FavoriteButton({ pressed, onChange, label = 'Favourite' }: { pressed: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" className={cx('jb-btn', 'jb-btn--icon', 'jb-btn--sm', 'jb-fav')} aria-pressed={pressed} aria-label={label} title={label} onClick={() => onChange(!pressed)}>
      <Icon name="heart" size={13} style={pressed ? undefined : { fill: 'none' }} />
    </button>
  );
}
