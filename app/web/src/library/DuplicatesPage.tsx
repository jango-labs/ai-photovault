import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { decideDuplicate, fetchDuplicates, imageUrl, scanDuplicates, type PairView } from '../api/library';
import { PageHeader } from '../shell/PageHeader';
import { Button, LinkButton } from '../ui/Button';
import { SegmentedControl } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { Meta } from '../ui/typography';
import { fmtCount } from './photoMap';

const STATES = [{ value: 'OPEN', label: 'To review' }, { value: 'DUPLICATE', label: 'Duplicates' }, { value: 'DISTINCT', label: 'Not duplicates' }] as const;
const bits = (d: number) => `${d} bit${d === 1 ? '' : 's'} apart`;
const closeness = (d: number) => (d === 0 ? 'identical image' : d <= 2 ? `very close (${bits(d)})` : d <= 4 ? `close (${bits(d)})` : `similar (${bits(d)})`);

/** Near-duplicate review: the most similar pairs first. Decisions are remembered; nothing is deleted, hidden or merged here. */
export function DuplicatesPage() {
  const qc = useQueryClient(); const toast = useToast();
  const [state, setState] = useState<PairView['state']>('OPEN');
  const q = useInfiniteQuery({ queryKey: ['library', 'dup-pairs', state], queryFn: ({ pageParam }) => fetchDuplicates(state, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['library'] }); };
  const scan = useMutation({
    mutationFn: () => scanDuplicates(), onSuccess: (r) => { refresh(); toast({ kind: 'ok', title: r.found ? `${fmtCount(r.found)} new similar pair${r.found === 1 ? '' : 's'} found` : 'No new similar photographs found', body: `${fmtCount(r.open)} waiting for review.` }); },
    onError: () => toast({ kind: 'error', title: 'The scan failed', body: 'Nothing was changed. Try again.' }),
  });
  const decide = useMutation({ mutationFn: (v: { id: string; state: PairView['state'] }) => decideDuplicate(v.id, v.state), onSuccess: refresh, onError: () => toast({ kind: 'error', title: 'That decision could not be saved' }) });
  return (
    <div className="jb-page" style={{ display: 'grid', gap: 16 }}>
      <PageHeader eyebrow="Library" title="Duplicates" lede="Photographs whose perceptual fingerprints are almost the same: re-exports, crops, resizes. You decide; nothing is deleted."
        actions={<><Button variant="outline" icon="refresh" disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? 'Scanning…' : 'Scan the library'}</Button><LinkButton variant="ghost" to="/library">Back to the library</LinkButton></>} />
      <div className="jb-row" style={{ justifyContent: 'space-between' }}>
        <SegmentedControl label="Show" value={state} onChange={setState} options={STATES.map((s) => ({ value: s.value, label: s.label }))} />
        <span className="t-meta t-num" role="status">{total !== undefined ? `${fmtCount(total)} pair${total === 1 ? '' : 's'}` : ''}</span>
      </div>
      {q.isError ? <ErrorState title="Pairs could not be loaded" onRetry={() => void q.refetch()} />
        : q.isLoading ? <div aria-busy="true" style={{ display: 'grid', gap: 12 }}><Skeleton height={220} /><Skeleton height={220} /></div>
        : items.length === 0 ? <EmptyState icon="compare" title={state === 'OPEN' ? 'Nothing to review' : 'Nothing here yet'}>{state === 'OPEN' ? 'Run a scan to compare perceptual fingerprints across your library. Photographs without a fingerprint (not yet imported fully) are skipped.' : 'Decisions you make appear here.'}</EmptyState>
        : (
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map((p) => (
              <article key={p.id} className="jb-pair" aria-label={`Similar pair: ${p.a.title} and ${p.b.title}`}>
                {[p.a, p.b].map((c) => (
                  <figure key={c.id} style={{ margin: 0, display: 'grid', gap: 6 }}>
                    <div className="jb-pair__img" style={c.dominant ? { background: c.dominant } : undefined}><img src={imageUrl(c.id, 'view')} alt={c.title} loading="lazy" /></div>
                    <figcaption className="t-meta"><Link to={`/library?photo=${c.id}`}>{c.title}</Link> · {c.width} × {c.height}{c.rating ? ` · ${c.rating}★` : ''}</figcaption>
                  </figure>
                ))}
                <div className="jb-pair__foot">
                  <Meta>{closeness(p.distance)}</Meta>
                  <span className="jb-row">
                    <Link className="jb-btn jb-btn--sm jb-btn--outline" to={`/library/compare?ids=${p.a.id},${p.b.id}`}>Compare</Link>
                    {p.state !== 'DUPLICATE' && <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: p.id, state: 'DUPLICATE' })}>Mark as duplicate</Button>}
                    {p.state !== 'DISTINCT' && <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: p.id, state: 'DISTINCT' })}>Not a duplicate</Button>}
                    {p.state !== 'OPEN' && <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: p.id, state: 'OPEN' })}>Review again</Button>}
                  </span>
                </div>
              </article>
            ))}
            {q.hasNextPage && <div><Button variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</Button></div>}
          </div>
        )}
    </div>
  );
}
