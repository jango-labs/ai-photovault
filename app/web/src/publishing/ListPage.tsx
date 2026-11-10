import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PUB_KEY, fetchDrafts, type Draft, type DraftState } from '../api/publishing';
import { imageUrl } from '../api/library';
import { PageHeader } from '../shell/PageHeader';
import { Button, LinkButton } from '../ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../ui/feedback';
import { StatusChip } from '../ui/status';

const when = (d: Draft) => (d.schedule ? new Date(d.schedule.scheduledAt).toLocaleString('en-GB', { timeZone: d.schedule.timezone, dateStyle: 'medium', timeStyle: 'short' }) : null);
export function PublishListPage({ sub, states, empty }: { sub: string; states: DraftState[]; empty: string }) {
  const q = useInfiniteQuery({ queryKey: [...PUB_KEY, 'list', states.join()], staleTime: 10_000, retry: false, queryFn: ({ pageParam }) => fetchDrafts(states, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="jb-page">
      <PageHeader eyebrow={`Publish · ${sub}`} title={sub} actions={<LinkButton variant="primary" to="/publish/compose">New post</LinkButton>} />
      {q.isError ? <ErrorState title={`${sub} could not be loaded`} onRetry={() => void q.refetch()}>Nothing was changed.</ErrorState>
        : q.isLoading ? <div aria-busy="true" role="status" aria-label="Loading" className="jb-coll__grid">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={220} />)}</div>
        : items.length === 0 ? <EmptyState icon="post" title={`No ${sub.toLowerCase()}`}>{empty}</EmptyState>
        : <ul className="jb-coll__grid" aria-label={sub}>{items.map((d) => (
          <li key={d.id}><Link to={`/publish/compose?draft=${d.id}`} className="jb-coll__card">
            <span className="jb-coll__cover"><img src={imageUrl(d.photoId, 'thumb')} alt="" loading="lazy" /></span>
            <span className="jb-row"><StatusChip state={d.state} compact /> <span className="t-meta">{d.state}{when(d) ? ` · ${when(d)}` : ''}</span></span>
            <span className="jb-coll__meta t-meta">{d.title ?? d.photo?.title ?? 'Photograph'}{d.caption ? ` — ${d.caption.slice(0, 80)}` : ' — no caption yet'}</span>
          </Link></li>))}</ul>}
      {q.hasNextPage && <div style={{ textAlign: 'center', margin: 16 }}><Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</Button></div>}
    </div>
  );
}
