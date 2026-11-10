import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { CURATOR_KEY, fetchFeedback, fetchRun, fetchRuns, fetchThemes, runCurator, saveDraft, sendFeedback, type CuratorRun, type Reason } from '../api/curator';
import { COLLECTIONS_KEY } from '../api/collections';
import { fetchDetail, imageUrl } from '../api/library';
import { useAuth } from '../auth/AuthProvider';
import { usePersistentState, useIsPhone } from '../lib/hooks';
import { AiPanel } from '../ai/AiPanel';
import { ViewerActions } from '../collections/ViewerActions';
import { DETAIL_KEY } from '../library/cache';
import { PhotoManagement } from '../library/PhotoManagement';
import { cardFromDetail, fmtCount, toPhotoItem, toViewerDetail } from '../library/photoMap';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Field, FilterChip, SegmentedControl } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { PhotoViewer } from '../ui/PhotoViewer';
import { Label, Meta } from '../ui/typography';

type Purpose = CuratorRun['purpose'];
const PURPOSE: Array<{ value: Purpose; label: string }> = [{ value: 'general', label: 'Best of' }, { value: 'instagram', label: 'For Instagram' }, { value: 'portfolio', label: 'For the portfolio' }];
const mark = (r: Reason) => (r.effect === 'plus' ? '+' : r.effect === 'minus' ? '−' : '·');

export function CuratorPage() {
  const [sp, setSp] = useSearchParams(); const qc = useQueryClient(); const toast = useToast(); const auth = useAuth(); const phone = useIsPhone();
  const runId = sp.get('run'); const photoId = sp.get('photo');
  const [request, setRequest] = useState(''); const [count, setCount] = useState(12); const [purpose, setPurpose] = useState<Purpose>('general');
  const runQ = useQuery({ queryKey: [...CURATOR_KEY, 'run', runId], enabled: !!runId, queryFn: () => fetchRun(runId!), staleTime: 60_000, retry: false });
  const run = runQ.data;
  useEffect(() => { if (run) { setRequest(run.request); setCount(run.count); setPurpose(run.purpose); } }, [run?.id]);
  const ideas = useQuery({ queryKey: [...CURATOR_KEY, 'themes'], queryFn: fetchThemes, staleTime: 60_000 });
  const recent = useQuery({ queryKey: [...CURATOR_KEY, 'runs'], queryFn: fetchRuns, staleTime: 10_000 });
  const feedback = useQuery({ queryKey: [...CURATOR_KEY, 'feedback'], queryFn: fetchFeedback, staleTime: 10_000 });
  const go = useMutation({
    mutationFn: (b: { request: string; count: number; purpose: Purpose }) => runCurator(b),
    onSuccess: (r) => { qc.setQueryData([...CURATOR_KEY, 'run', r.id], r); void qc.invalidateQueries({ queryKey: [...CURATOR_KEY, 'runs'] }); setSp({ run: r.id }); },
    onError: () => toast({ kind: 'error', title: 'The curator could not run', body: 'Nothing was changed.' }),
  });
  const start = (b = { request, count, purpose }) => go.mutate(b);

  // ---- the person's overrides: the selection starts as the curator's picks and is theirs to change
  const [chosen, setChosen] = useState<string[]>([]); const [showHidden, setShowHidden] = useState<Set<string>>(new Set()); const [draftName, setDraftName] = useState('');
  useEffect(() => { setChosen(run?.picks.map((p) => p.id) ?? []); setShowHidden(new Set()); setDraftName(''); }, [run?.id]);
  const cardOf = (id: string) => run?.cards[id];
  const verdict = useMemo(() => new Map([...(feedback.data?.liked ?? []).map((c) => [c.id, 'LIKE'] as const), ...(feedback.data?.disliked ?? []).map((c) => [c.id, 'DISLIKE'] as const)]), [feedback.data]);
  const rate = (id: string, v: 'LIKE' | 'DISLIKE' | 'CLEAR') => {
    if (v === 'DISLIKE') setChosen((c) => c.filter((x) => x !== id));
    sendFeedback(id, v, run?.id).then(() => qc.invalidateQueries({ queryKey: [...CURATOR_KEY, 'feedback'] })).catch(() => toast({ kind: 'error', title: 'Your feedback could not be saved' }));
  };
  const save = useMutation({
    mutationFn: () => saveDraft(run!.id, chosen, draftName.trim() || undefined),
    onSuccess: (d) => { void qc.invalidateQueries({ queryKey: COLLECTIONS_KEY }); toast({ kind: 'ok', title: `Saved as AI draft “${d.name}”`, body: 'It stays a draft until you activate it in Collections → AI drafts. Nothing was published or scheduled.' }); },
    onError: (e) => toast({ kind: 'error', title: 'The draft could not be saved', body: e instanceof ApiError ? e.message : undefined }),
  });

  // ---- viewer over the current selection
  const items = useMemo(() => chosen.map((id) => cardOf(id)).filter((c): c is NonNullable<typeof c> => !!c).map(toPhotoItem), [chosen, run]);
  const index = photoId ? items.findIndex((i) => i.id === photoId) : -1;
  const detailQ = useQuery({ queryKey: DETAIL_KEY(photoId ?? ''), queryFn: () => fetchDetail(photoId!), enabled: !!photoId, staleTime: 30_000 });
  const openPhoto = (id: string) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', id); return n; });
  const closeViewer = () => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('photo'); return n; }, { replace: true });
  const [panelOpen, setPanelOpen] = usePersistentState(`jb-viewer-panel-${phone ? 'phone' : 'desktop'}`, !phone);
  const viewerItems = index >= 0 ? items : detailQ.data ? [toPhotoItem(cardFromDetail(detailQ.data))] : [];
  const detailFor = useCallback((p: (typeof items)[number]) => toViewerDetail(detailQ.data?.id === p.id ? detailQ.data : undefined, p), [detailQ.data]);

  const pickOf = (id: string) => run?.picks.find((p) => p.id === id);
  const altOf = (id: string) => run?.alternatives.find((p) => p.id === id);
  return (
    <div className="jb-page">
      <PageHeader eyebrow="Workspace" title="AI Curator" lede="Ask for a selection and see the reasoning. The curator only advises: it never edits, publishes or schedules anything." />
      <form className="jb-cur__ask" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <Field label="What should I look for?" value={request} onChange={setRequest} maxLength={300} placeholder="e.g. my best lion photographs from Kenya since 2023" />
        <SegmentedControl<Purpose> label="Purpose" value={purpose} onChange={setPurpose} options={PURPOSE} />
        <Field label="How many" value={String(count)} onChange={(v) => setCount(Math.max(1, Math.min(60, Number(v.replace(/\D/g, '')) || 1)))} inputMode="numeric" maxLength={2} />
        <Button type="submit" variant="primary" disabled={go.isPending}>{go.isPending ? 'Choosing…' : 'Suggest a selection'}</Button>
      </form>

      {!runId && (
        <div className="jb-cur__home">
          <section aria-label="Ideas"><Label>Ideas from your library</Label>
            {ideas.data?.items.length ? <div className="jb-filter-opts">{ideas.data.items.map((t) => <button key={t.request} type="button" className="jb-opt" onClick={() => { setRequest(t.request); setPurpose('instagram'); start({ request: t.request, count, purpose: 'instagram' }); }}>{t.title}<span className="n">{fmtCount(t.count)}</span></button>)}</div>
              : <Meta>{ideas.isLoading ? 'Looking…' : 'Rate some photographs 4 or 5 stars and ideas will appear here.'}</Meta>}
          </section>
          <section aria-label="Recent selections"><Label>Recent selections</Label>
            {recent.data?.items.length ? <ul className="jb-search__list">{recent.data.items.map((r) => <li key={r.id}><Link to={`/curator?run=${r.id}`}>{r.request || 'My best photographs'}</Link><span className="t-meta"> — {r.picks} picked · {r.purpose}</span></li>)}</ul> : <Meta>None yet.</Meta>}
          </section>
          {(feedback.data?.disliked.length ?? 0) > 0 && <section aria-label="Left out"><Label>You said “not this”</Label><Meta>{feedback.data!.disliked.length} photograph{feedback.data!.disliked.length === 1 ? ' is' : 's are'} kept out of every suggestion. Open one in a selection to change your mind.</Meta></section>}
        </div>
      )}

      {runId && runQ.isError && <ErrorState title="That selection could not be loaded" onRetry={() => void runQ.refetch()}>It may have been pruned (the last 30 are kept).</ErrorState>}
      {runId && runQ.isLoading && <div aria-busy="true" role="status" aria-label="Loading selection" className="jb-cur__grid">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={260} />)}</div>}
      {run && (
        <section aria-label="Selection">
          <div className="jb-lib__chips" role="group" aria-label="Understood as">
            <Label>Understood as</Label>{run.understood.map((u) => <FilterChip key={`${u.kind}:${u.label}`} name={u.kind === 'tone' ? 'LOOK' : u.kind.toUpperCase()} value={u.label} />)}{run.words && <FilterChip name="WORDS" value={run.words} />}
          </div>
          {run.assumed.map((a) => <Meta key={a}>Assumed: {a}.</Meta>)}
          <Meta>Chose {run.picks.length} of {fmtCount(run.pool.matching)} matching photograph{run.pool.matching === 1 ? '' : 's'}{run.pool.matching > run.pool.examined ? ` (looked at the best ${fmtCount(run.pool.examined)} by rating and measured quality)` : ''}.
            {run.skipped.series > 0 && ` ${run.skipped.series} near-identical frame${run.skipped.series === 1 ? '' : 's'} grouped behind the best of their series.`}
            {run.skipped.disliked > 0 && ` ${run.skipped.disliked} you marked “not this” ${run.skipped.disliked === 1 ? 'was' : 'were'} left out.`}
            {run.skipped.alreadyInPortfolio > 0 && ` ${run.skipped.alreadyInPortfolio} already in the portfolio left out.`}</Meta>
          {run.picks.length === 0 ? <EmptyState icon="curator" title="Nothing to suggest">No photograph matched. Try fewer words or another purpose; the curator never invents a match.</EmptyState> : (
            <>
              <div className="jb-bulk" role="toolbar" aria-label="Save selection">
                <span className="jb-bulk__count" role="status" aria-live="polite">{chosen.length} in your selection</span><span className="grow" />
                <Field label="Draft name (optional)" value={draftName} onChange={setDraftName} maxLength={80} />
                <Button variant="primary" disabled={chosen.length === 0 || save.isPending} onClick={() => save.mutate()}>Save as AI draft collection</Button>
              </div>
              <ol className="jb-cur__grid" aria-label="Suggested photographs">
                {chosen.map((id, i) => {
                  const c = cardOf(id); const p = pickOf(id) ?? altOf(id); if (!c || !p) return null;
                  const hidden = pickOf(id)?.hidden ?? []; const more = Math.max(hidden.length, (pickOf(id)?.seriesSize ?? 1) - 1);
                  return (
                    <li key={id} className="jb-cur__card">
                      <button type="button" className="jb-cur__thumb" onClick={() => openPhoto(id)} aria-label={`Open ${c.title}`}><img src={imageUrl(id, 'thumb')} alt={c.title} loading="lazy" /></button>
                      <div className="jb-cur__body">
                        <p className="jb-cur__title"><span className="t-num">{i + 1}.</span> {c.title} <span className="t-meta t-num" title="Advisory score, 0 to 1">score {p.score.toFixed(2)}</span></p>
                        <ul className="jb-cur__why" aria-label={`Why ${c.title}`}>{p.reasons.map((r) => <li key={r.text} data-effect={r.effect}><span aria-hidden>{mark(r)}</span> {r.text}</li>)}</ul>
                        <div className="jb-row" style={{ flexWrap: 'wrap' }}>
                          <Button size="sm" variant={verdict.get(id) === 'LIKE' ? 'outline' : 'ghost'} aria-pressed={verdict.get(id) === 'LIKE'} onClick={() => rate(id, verdict.get(id) === 'LIKE' ? 'CLEAR' : 'LIKE')}>Like</Button>
                          <Button size="sm" variant="ghost" onClick={() => rate(id, 'DISLIKE')}>Not this</Button>
                          <Button size="sm" variant="ghost" onClick={() => setChosen((x) => x.filter((y) => y !== id))}>Leave out</Button>
                          {more > 0 && <Button size="sm" variant="ghost" aria-expanded={showHidden.has(id)} onClick={() => setShowHidden((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}>{more} similar frame{more === 1 ? '' : 's'}</Button>}
                        </div>
                        {showHidden.has(id) && <div className="jb-cur__series" aria-label="Similar frames in this series">{hidden.map((h) => cardOf(h) && <button key={h} type="button" onClick={() => openPhoto(h)} aria-label={`Open similar frame ${cardOf(h)!.title}`}><img src={imageUrl(h, 'thumb')} alt="" loading="lazy" /></button>)}</div>}
                      </div>
                    </li>);
                })}
              </ol>
              {chosen.length < run.picks.length + 0 && run.picks.some((p) => !chosen.includes(p.id)) && (
                <div className="jb-row"><Meta>Left out by you:</Meta>{run.picks.filter((p) => !chosen.includes(p.id) && verdict.get(p.id) !== 'DISLIKE').map((p) => <Button key={p.id} size="sm" variant="ghost" onClick={() => setChosen((c) => [...c, p.id])}>Put back “{cardOf(p.id)?.title}”</Button>)}</div>)}
              {run.alternatives.filter((a) => !chosen.includes(a.id) && verdict.get(a.id) !== 'DISLIKE').length > 0 && (
                <section aria-label="Also considered"><Label>Also considered</Label>
                  <div className="jb-cur__alts">{run.alternatives.filter((a) => !chosen.includes(a.id) && verdict.get(a.id) !== 'DISLIKE').map((a) => cardOf(a.id) && (
                    <figure key={a.id}><img src={imageUrl(a.id, 'thumb')} alt={cardOf(a.id)!.title} loading="lazy" /><figcaption className="t-meta">{cardOf(a.id)!.title} · {a.score.toFixed(2)}</figcaption>
                      <Button size="sm" variant="outline" onClick={() => setChosen((c) => [...c, a.id])}>Add to selection</Button></figure>))}</div>
                </section>)}
            </>)}
        </section>)}

      {photoId && viewerItems.length > 0 && (
        <PhotoViewer items={viewerItems} index={index >= 0 ? index : 0} onIndexChange={(i) => openPhoto(viewerItems[i]!.id)} onClose={closeViewer} detail={detailFor}
          surface={auth.settings?.viewerSurface ?? 'neutral'} onSurfaceChange={(s) => void auth.updateSettings({ viewerSurface: s })} panelOpen={panelOpen} onPanelOpenChange={setPanelOpen}
          renderInfoExtras={(p) => <><ViewerActions photoId={p.id} /><PhotoManagement photoId={p.id} /></>} renderAiTab={(p) => <AiPanel photoId={p.id} />} />
      )}
    </div>
  );
}
