import { useEffect } from 'react';
import { Button } from '../Button';
import { MatchBadge } from '../status';
import { formatPostDate } from './HistoryGrid';

export type MatchDecision = 'confirm' | 'reject' | 'skip';

/**
 * Side-by-side review of a POSSIBLE match: Instagram image vs library photograph. Shown on the neutral viewer surface so
 * colour/tone can be judged. Shortcuts: Y confirm · N not the same · S skip. Decisions are remembered by the app (never re-asked).
 */
export function MatchCompare({ instagram, library, similarity, signals, onDecide }: {
  instagram: { src: string; alt: string; postedAt: string; caption: string };
  library: { src: string; alt: string; title: string; place?: string };
  similarity: number; signals: Array<[string, string]>; onDecide: (d: MatchDecision) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if (e.key === 'y' || e.key === 'Y') onDecide('confirm'); else if (e.key === 'n' || e.key === 'N') onDecide('reject'); else if (e.key === 's' || e.key === 'S') onDecide('skip');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onDecide]);
  return (
    <div className="jb-compare" style={{ ['--viewer-surface' as string]: '#2e2e2e' }}>
      <figure>
        <figcaption><p className="label">Instagram</p><p className="t-meta t-num">{formatPostDate(instagram.postedAt)}</p></figcaption>
        <div className="img"><img src={instagram.src} alt={instagram.alt} /></div>
      </figure>
      <div className="jb-compare__mid">
        <p className="t-stat"><span aria-hidden>{Math.round(similarity * 100)}<span style={{ fontSize: '0.5em' }}>%</span></span><span className="jb-sr-only">Similarity {Math.round(similarity * 100)} percent</span></p>
        <MatchBadge state="POSSIBLE_MATCH" />
        <dl className="jb-kv" style={{ gridTemplateColumns: 'auto auto', fontSize: 12 }}>{signals.map(([k, v]) => <><dt key={k}>{k}</dt><dd key={k + 'v'}>{v}</dd></>)}</dl>
        <Button variant="primary" onClick={() => onDecide('confirm')}>Confirm same photo <kbd>Y</kbd></Button>
        <Button variant="outline" onClick={() => onDecide('reject')}>Not same photo <kbd>N</kbd></Button>
        <Button variant="ghost" onClick={() => onDecide('skip')}>Skip <kbd>S</kbd></Button>
      </div>
      <figure>
        <figcaption><p className="label">AI PhotoVault</p><p className="t-meta">{library.title}{library.place ? ` · ${library.place}` : ''}</p></figcaption>
        <div className="img"><img src={library.src} alt={library.alt} /></div>
      </figure>
    </div>
  );
}
