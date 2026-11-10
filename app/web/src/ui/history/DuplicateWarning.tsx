import { Button } from '../Button';
import { formatPostDate } from './HistoryGrid';

/** Shown before scheduling/publishing when the photograph (or a very similar one) has already been posted. Informs; never forbids. */
export function DuplicateWarning({ kind, last, onView, onContinue, onCancel }: {
  kind: 'same' | 'similar';
  last: { src: string; alt: string; postedAt: string; caption: string };
  onView: () => void; onContinue: () => void; onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-labelledby="dupe-title" className="ds__panel" style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 16, border: '1px solid color-mix(in srgb, var(--warn) 50%, transparent)' }}>
      <img src={last.src} alt={last.alt} style={{ width: 96, height: 120, objectFit: 'cover', borderRadius: 4 }} />
      <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
        <p id="dupe-title" className="label" style={{ color: 'var(--warn)' }}>{kind === 'same' ? 'This photograph was previously posted' : 'A similar image was previously posted'}</p>
        <p className="t-meta">Last posted <span className="t-num" style={{ color: 'var(--text)' }}>{formatPostDate(last.postedAt)}</span></p>
        <p className="jb-hist__cap">{last.caption}</p>
        <div className="jb-row"><Button size="sm" variant="outline" icon="external" onClick={onView}>View previous post</Button><Button size="sm" variant="secondary" onClick={onContinue}>Continue anyway</Button><Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button></div>
      </div>
    </div>
  );
}
