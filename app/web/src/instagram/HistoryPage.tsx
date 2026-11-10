import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  IG_KEY, createSynthetic, decideMatch, fetchIgAccount, fetchIgHistory, fetchReview, igImage, linkMedia, rematch, syncNow, type IgFilter, type IgPost, type ReviewItem,
} from '../api/instagram';
import { ApiError } from '../api/client';
import { fetchPhotos, imageUrl, defaultQuery } from '../api/library';
import { fmtCount } from '../library/photoMap';
import { ConnectionCard } from './ConnectionCard';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, SegmentedControl } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { HistoryGrid, formatPostDate, type HistoryItem } from '../ui/history/HistoryGrid';
import { MatchCompare, type MatchDecision } from '../ui/history/MatchCompare';
import { MatchBadge } from '../ui/status';
import { Label, Meta } from '../ui/typography';

const FILTERS: Array<{ value: IgFilter; label: string }> = [{ value: 'all', label: 'All' }, { value: 'matched', label: 'Matched' }, { value: 'review', label: 'Needs review' }, { value: 'unmatched', label: 'Not in my library' }];
const toItem = (p: IgPost): HistoryItem => ({
  id: p.id, src: p.mediaId ? igImage(p.mediaId) : '', alt: `Instagram post from ${formatPostDate(p.postedAt)}${p.caption ? `: ${p.caption.slice(0, 80)}` : ''}`, postedAt: p.postedAt, caption: p.caption ?? '', hashtags: p.hashtags,
  ...(p.permalink ? { permalink: p.permalink } : {}), ...(p.match ? { match: { state: p.match.state, ...(p.match.score !== null ? { similarity: p.match.score } : {}), photoTitle: p.match.photoTitle } } : {}),
});
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : String(Math.round(x * 100)));

export function InstagramHistoryPage() {
  const qc = useQueryClient(); const toast = useToast();
  const [filter, setFilter] = useState<IgFilter>('all'); const [open, setOpen] = useState<IgPost | null>(null); const [linking, setLinking] = useState(false);
  const account = useQuery({ queryKey: [...IG_KEY, 'account'], queryFn: fetchIgAccount, refetchInterval: (q) => (q.state.data?.syncing ? 2500 : false) });
  const hist = useInfiniteQuery({
    queryKey: [...IG_KEY, 'history', filter], staleTime: 15_000, retry: false, queryFn: ({ pageParam }) => fetchIgHistory(filter, pageParam),
    initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const review = useQuery({ queryKey: [...IG_KEY, 'review'], queryFn: () => fetchReview(50), staleTime: 10_000 });
  const posts = useMemo(() => hist.data?.pages.flatMap((p) => p.items) ?? [], [hist.data]);
  const st = account.data?.stats;
  const counts = hist.data?.pages[0]?.counts ?? (st ? { all: st.posts, matched: st.matched, review: st.review, unmatched: st.unmatched } : null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: IG_KEY }); void qc.invalidateQueries({ queryKey: ['library'] }); };
  const err = (what: string, e: unknown) => toast({ kind: 'error', title: `${what} failed`, body: e instanceof ApiError ? e.message : 'Nothing was changed.' });

  const makeSynthetic = useMutation({ mutationFn: () => createSynthetic(40), onSuccess: (r) => { toast({ kind: 'ok', title: 'Synthetic archive created', body: `${r.archive.posts} made-up posts built from your own library pictures. The worker is syncing them now — nothing is connected to Instagram.` }); refresh(); }, onError: (e) => err('Creating the archive', e) });
  const sync = useMutation({ mutationFn: syncNow, onSuccess: () => { toast({ kind: 'info', title: 'Sync queued' }); refresh(); }, onError: (e) => err('Syncing', e) });
  const recheck = useMutation({ mutationFn: rematch, onSuccess: () => { toast({ kind: 'info', title: 'Matching again', body: 'Your earlier decisions are kept.' }); refresh(); }, onError: (e) => err('Matching', e) });
  const decide = async (id: string, d: 'confirm' | 'reject') => { try { await decideMatch(id, d); refresh(); setOpen(null); } catch (e) { err('Saving your decision', e); } };

  const a = account.data; const total = a?.stats.posts ?? 0; const fetchMore = useCallback(() => { if (hist.hasNextPage && !hist.isFetchingNextPage) void hist.fetchNextPage(); }, [hist]);
  return (
    <div className="jb-page">
      <PageHeader eyebrow="Publish · History" title="Instagram history" lede="Everything you have already published, as a photographic archive — matched to your library so you never post the same photograph by accident."
        actions={(review.data?.total ?? 0) > 0 ? <a className="jb-btn jb-btn--primary" href="#review">Review {review.data!.total} possible match{review.data!.total === 1 ? '' : 'es'}</a> : undefined} />
      <ConnectionCard />
      <section className="jb-ig__account" aria-label="Account">
        {a?.account ? (
          <>
            <p><b>{a.account.synthetic ? 'Synthetic archive' : `@${a.account.username ?? 'account'}`}</b> — {a.account.synthetic ? 'made-up posts for development; this app is not connected to Instagram.' : a.account.status === 'EXPIRED' ? 'the connection has expired.' : 'read-only history.'}</p>
            <Meta>{a.lastRun ? `Last sync ${a.lastRun.status === 'FAILED' ? 'failed' : a.lastRun.status === 'PARTIAL' ? 'was partial' : 'finished'} ${a.lastRun.finishedAt ? formatPostDate(a.lastRun.finishedAt) : ''}: ${a.lastRun.postsSeen} posts seen, ${a.lastRun.postsNew} new, ${a.lastRun.matched} matched${a.lastRun.mediaFailed ? `, ${a.lastRun.mediaFailed} image(s) will be retried` : ''}.` : 'Not synced yet.'}{a.syncing && ' Syncing…'}</Meta>
            <div className="jb-row"><Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending || a.syncing}>Sync now</Button><Button size="sm" variant="ghost" onClick={() => recheck.mutate()} disabled={recheck.isPending}>Match against my library again</Button>{a.capabilities.synthetic && <Button size="sm" variant="ghost" onClick={() => makeSynthetic.mutate()} disabled={makeSynthetic.isPending}>Rebuild the synthetic archive</Button>}</div>
          </>
        ) : (
          <>
            <p><b>No Instagram account is connected.</b> Connecting a real account needs a Meta app and your approval; until then the history is empty.</p>
            {a?.capabilities.synthetic && <div className="jb-row"><Button variant="outline" onClick={() => makeSynthetic.mutate()} disabled={makeSynthetic.isPending}>Create a synthetic archive from my library</Button><Meta>Builds made-up posts from your own library pictures, to try matching and review. Development databases only.</Meta></div>}
          </>
        )}
      </section>

      <div className="jb-row" style={{ margin: '14px 0' }}>
        <SegmentedControl<IgFilter> label="Show" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: counts ? `${f.label} ${fmtCount(counts[f.value])}` : f.label }))} />
      </div>
      {hist.isError && !hist.data ? <ErrorState title="The history could not be loaded" onRetry={() => void hist.refetch()}>Nothing was changed.</ErrorState>
        : hist.isLoading ? <div aria-busy="true" role="status" aria-label="Loading history" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} width={190} height={240} />)}</div>
        : posts.length === 0 ? <EmptyState icon="post" title={total === 0 ? 'No posts yet' : 'Nothing here'}>{total === 0 ? 'When an account is synced, its posts appear here as an archive, each matched to the photograph in your library when it can be.' : 'No posts in this view.'}</EmptyState>
        : <>
          <HistoryGrid items={posts.map(toItem)} onOpen={(id) => setOpen(posts.find((p) => p.id === id) ?? null)} />
          {hist.hasNextPage && <div style={{ textAlign: 'center', margin: 16 }}><Button variant="outline" onClick={fetchMore} disabled={hist.isFetchingNextPage}>{hist.isFetchingNextPage ? 'Loading…' : 'Load older posts'}</Button></div>}
        </>}

      <section id="review" aria-label="Possible matches" style={{ marginTop: 36 }}>
        <Label>Possible matches</Label>
        <ReviewQueue items={review.data?.items ?? []} total={review.data?.total ?? 0} loading={review.isLoading} onDecided={refresh} />
      </section>

      <Dialog open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }} title={open ? `Post from ${formatPostDate(open.postedAt)}` : ''} description={open?.synthetic ? 'A synthetic post — there is no page for it on Instagram.' : undefined}
        actions={<Button variant="ghost" onClick={() => setOpen(null)}>Close</Button>}>
        {open && (
          <div className="jb-ig__post">
            {open.mediaId && <img src={igImage(open.mediaId)} alt={`Instagram post from ${formatPostDate(open.postedAt)}`} />}
            <div>
              {open.caption && <p>{open.caption}</p>}
              {open.permalink && <a href={open.permalink} target="_blank" rel="noreferrer noopener">View on Instagram</a>}
              {open.match ? (
                <div className="jb-ig__match">
                  <p><MatchBadge state={open.match.state} {...(open.match.score !== null ? { similarity: open.match.score } : {})} /> <Link to={`/library?photo=${open.match.photoId}`}>{open.match.photoTitle}</Link></p>
                  <div className="jb-row">
                    {open.match.state !== 'USER_CONFIRMED' && <Button size="sm" variant="outline" onClick={() => void decide(open.match!.id, 'confirm')}>Yes, it is this photograph</Button>}
                    <Button size="sm" variant="ghost" onClick={() => void decide(open.match!.id, 'reject')}>{open.match.state === 'USER_CONFIRMED' ? 'Unlink' : 'Not this photograph'}</Button>
                  </div>
                </div>
              ) : <div className="jb-ig__match"><Meta>Not matched to any photograph in your library.</Meta>{open.mediaId && <Button size="sm" variant="outline" onClick={() => setLinking(true)}>Link to a photograph…</Button>}</div>}
            </div>
          </div>)}
      </Dialog>
      {open?.mediaId && <LinkDialog open={linking} onOpenChange={setLinking} onPick={async (photoId) => { try { await linkMedia(open.mediaId!, photoId); setLinking(false); setOpen(null); refresh(); toast({ kind: 'ok', title: 'Linked', body: 'Saved as your decision.' }); } catch (e) { err('Linking', e); } }} />}
    </div>
  );
}

function LinkDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (photoId: string) => void }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const res = useQuery({ queryKey: [...IG_KEY, 'link-search', term], enabled: open, staleTime: 15_000, queryFn: () => fetchPhotos({ ...defaultQuery(), q: term }, undefined, 24) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Link to a photograph" description="Search by title, filename or place, then choose the photograph this post shows." actions={<Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>}>
      <Field label="Search your library" value={q} onChange={setQ} autoFocus />
      <ul className="jb-ig__pick" aria-label="Photographs">{(res.data?.items ?? []).map((p) => <li key={p.id}><button type="button" onClick={() => onPick(p.id)} aria-label={`Link to ${p.title}`}><img src={imageUrl(p.id, 'thumb')} alt="" loading="lazy" /><span>{p.title}</span></button></li>)}</ul>
      {res.isSuccess && res.data.items.length === 0 && <Meta>No photograph matches.</Meta>}
    </Dialog>
  );
}

function ReviewQueue({ items, total, loading, onDecided }: { items: ReviewItem[]; total: number; loading: boolean; onDecided: () => void }) {
  const toast = useToast(); const [skipped, setSkipped] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false);
  const queue = items.filter((i) => !skipped.has(i.matchId)); const cur = queue[0];
  const onDecide = useCallback(async (d: MatchDecision) => {
    if (!cur || busy) return;
    if (d === 'skip') { setSkipped((s) => new Set(s).add(cur.matchId)); return; }
    setBusy(true);
    try { await decideMatch(cur.matchId, d === 'confirm' ? 'confirm' : 'reject'); onDecided(); } catch (e) { toast({ kind: 'error', title: 'Your decision could not be saved', body: e instanceof ApiError ? e.message : undefined }); } finally { setBusy(false); }
  }, [cur, busy, onDecided, toast]);
  if (loading) return <Skeleton height={260} />;
  if (!cur) return <EmptyState icon="check" title={total === 0 ? 'Nothing to review' : 'You have skipped everything for now'}>{total === 0 ? 'Every post is either matched or has no plausible match in your library. Your decisions are remembered and never asked twice.' : 'Skipped matches come back next time you open this page.'}</EmptyState>;
  const s = cur.signals;
  return (
    <div>
      <Meta>{queue.length} of {total} to review{cur.alternatives > 0 ? ` · ${cur.alternatives} other candidate${cur.alternatives === 1 ? '' : 's'} for this post` : ''}. Y confirms, N rejects, S skips.</Meta>
      <MatchCompare key={cur.matchId} instagram={{ src: igImage(cur.post.mediaId), alt: 'Instagram image', postedAt: cur.post.postedAt, caption: cur.post.caption ?? '' }}
        library={{ src: imageUrl(cur.photo.id, 'view'), alt: cur.photo.title, title: cur.photo.title, ...(cur.photo.location ? { place: cur.photo.location } : {}) }} similarity={cur.score}
        signals={[['Visual', pct(s.embedding ?? cur.embeddingSimilarity)], ['pHash distance', cur.phashDistance === null ? '—' : String(cur.phashDistance)], ['Date', s.dateConsistent === null || s.dateConsistent === undefined ? 'unknown' : s.dateConsistent ? 'consistent' : 'inconsistent'], ['Caption', s.captionOverlap ? `${pct(s.captionOverlap)}% words` : 'no overlap']]} onDecide={(d) => void onDecide(d)} />
    </div>
  );
}
