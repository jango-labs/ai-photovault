import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchDetail, patchPhoto, type PhotoSet } from '../api/library';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { usePersistentState, useIsPhone } from '../lib/hooks';
import { emptySelection, type SelectionState } from '../lib/selection';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, FilterChip, SearchField } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { PhotoGrid } from '../ui/PhotoGrid';
import { PhotoViewer } from '../ui/PhotoViewer';
import { Label, Meta } from '../ui/typography';
import { AiPanel } from '../ai/AiPanel';
import { DETAIL_KEY, patchLoaded } from '../library/cache';
import { PhotoManagement } from '../library/PhotoManagement';
import { cardFromDetail, fmtCount, toPhotoItem, toViewerDetail } from '../library/photoMap';
import {
  clearHistory, deleteHistory, deleteSaved, exclusionKey, fetchDiscover, fetchHistory, fetchSaved, fetchSearch, fetchSimilar, reindexSearch, saveSearch, searchHref,
} from './api';
import { ViewerActions } from '../collections/ViewerActions';
import { AddToCollection } from '../collections/AddToCollection';

export const SEARCH_KEY = ['search'] as const;

export function SearchPage() {
  const [sp, setSp] = useSearchParams();
  const auth = useAuth(); const qc = useQueryClient(); const toast = useToast(); const phone = useIsPhone();
  const q = (sp.get('q') ?? '').trim(); const exclude = sp.getAll('x'); const similarId = sp.get('similar'); const photoId = sp.get('photo');
  const mode: 'similar' | 'results' | 'home' = similarId ? 'similar' : q ? 'results' : 'home';
  const [draft, setDraft] = useState(q);
  useEffect(() => { setDraft(q); }, [q]);
  const [saveOpen, setSaveOpen] = useState(false); const [saveName, setSaveName] = useState('');
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [collOpen, setCollOpen] = useState(false);

  const results = useInfiniteQuery({
    queryKey: [...SEARCH_KEY, 'results', q, exclude], enabled: mode === 'results', staleTime: 60_000, retry: false,
    queryFn: ({ pageParam }) => fetchSearch(q, exclude, pageParam),
    initialPageParam: 0, getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const similar = useQuery({ queryKey: [...SEARCH_KEY, 'similar', similarId], enabled: mode === 'similar', staleTime: 60_000, retry: false, queryFn: () => fetchSimilar(similarId!) });
  const sourceDetail = useQuery({ queryKey: DETAIL_KEY(similarId ?? ''), enabled: mode === 'similar', queryFn: () => fetchDetail(similarId!), staleTime: 30_000 });

  const cards = useMemo(() => (mode === 'similar' ? similar.data?.items ?? [] : results.data?.pages.flatMap((p) => p.items) ?? []), [mode, similar.data, results.data]);
  const items = useMemo(() => cards.map(toPhotoItem), [cards]);
  const first = results.data?.pages[0];
  const understood = first?.parsed.understood ?? [];
  const fetchMore = useCallback(() => { if (mode === 'results' && results.hasNextPage && !results.isFetchingNextPage && !results.isError) void results.fetchNextPage(); }, [mode, results]);

  const go = (nextQ: string, nextExclude: string[] = []) => setSp(new URLSearchParams(searchHref(nextQ, nextExclude).split('?')[1] ?? ''));
  const removePhrase = (key: string) => go(q, [...exclude, key]);

  // ---- viewer (?photo=<id> keeps the search in the URL)
  const index = photoId ? items.findIndex((i) => i.id === photoId) : -1;
  const detailQ = useQuery({ queryKey: DETAIL_KEY(photoId ?? ''), queryFn: () => fetchDetail(photoId!), enabled: !!photoId, staleTime: 30_000 });
  const openAt = (i: number) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', items[i]!.id); return n; });
  const closeViewer = () => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('photo'); return n; }, { replace: true });
  const [panelOpen, setPanelOpen] = usePersistentState(`jb-viewer-panel-${phone ? 'phone' : 'desktop'}`, !phone);
  const viewerItems = index >= 0 ? items : detailQ.data ? [toPhotoItem(cardFromDetail(detailQ.data))] : [];
  const detailFor = useCallback((p: (typeof items)[number]) => toViewerDetail(detailQ.data?.id === p.id ? detailQ.data : undefined, p), [detailQ.data]);
  const editOne = useCallback((id: string, set: PhotoSet) => {
    patchLoaded(qc, (x) => x === id, set);
    patchPhoto(id, set).catch(() => { void qc.invalidateQueries({ queryKey: ['library'] }); void qc.invalidateQueries({ queryKey: SEARCH_KEY }); toast({ kind: 'error', title: 'That change could not be saved', body: 'Your change was reverted.' }); });
  }, [qc, toast]);

  async function doSave() {
    try {
      await saveSearch(saveName.trim(), q, exclude); setSaveOpen(false); setSaveName('');
      void qc.invalidateQueries({ queryKey: [...SEARCH_KEY, 'saved'] });
      toast({ kind: 'ok', title: 'Search saved', body: 'The query is saved, not its results — it always shows what matches now.' });
    } catch (e) { toast({ kind: 'error', title: e instanceof ApiError && e.status === 409 ? 'That name is already used' : 'The search could not be saved', body: e instanceof ApiError ? e.message : undefined }); }
  }

  const rowHeight = phone ? 150 : (auth.settings?.thumbSize ?? 240);
  const notIndexed = similar.error instanceof ApiError && similar.error.code === 'not_embedded';

  return (
    <div className="jb-lib">
      <div className="jb-lib__head">
        <h1 className="jb-sr-only">Search</h1>
        <div className="jb-search__bar">
          <SearchField className="jb-search__field" label="Search your photographs" placeholder="Try “lions in Kenya in 2024 that I never posted”" hint={null} value={draft} onChange={setDraft} onSubmit={(v) => go(v.trim())} />
          {mode === 'results' && <Button variant="outline" onClick={() => { setSaveName(q.slice(0, 60)); setSaveOpen(true); }}>Save search</Button>}
        </div>
        {mode === 'results' && first && (
          <div className="jb-search__explain" aria-live="polite">
            {understood.length > 0 && (
              <div className="jb-lib__chips" role="group" aria-label="Understood as">
                <Label>Understood as</Label>
                {understood.map((u) => <FilterChip key={exclusionKey(u)} name={u.kind === 'tone' ? 'LOOK' : u.kind.toUpperCase()} value={u.label} onRemove={() => removePhrase(exclusionKey(u))} />)}
                {first.parsed.text && <FilterChip name="WORDS" value={first.parsed.text} />}
              </div>
            )}
            {first.relaxed && <Meta>No photograph contains all of those words, so photographs matching any of them are shown.</Meta>}
            <Meta>{first.total === 0 ? 'No photographs match.' : `${fmtCount(first.total)} photograph${first.total === 1 ? '' : 's'}`} · <span title={first.semantic.reason}>{first.semantic.used ? `Matched by words and by meaning (descriptions from the local vision model, ${first.semantic.coverage?.embedded ?? 0} of ${first.semantic.coverage?.photos ?? 0} photographs).` : 'Matched by words only: titles, places, equipment, keywords, species and descriptions (not by meaning).'}</span></Meta>
          </div>
        )}
        {mode === 'similar' && (
          <div className="jb-search__explain">
            <Meta>Photographs that look most like <b>{sourceDetail.data?.title ?? 'this photograph'}</b>, by colour and layout (local model <span className="t-num">local-visual-v1</span>). <Link to="/search">Back to search</Link></Meta>
          </div>
        )}
      </div>

      <div className="jb-lib__body">
        {selection.selected.size > 0 && (
          <div className="jb-bulk" role="toolbar" aria-label="Bulk actions">
            <span className="jb-bulk__count" role="status" aria-live="polite">{fmtCount(selection.selected.size)} selected</span><span className="grow" />
            <Button size="sm" variant="outline" onClick={() => setCollOpen(true)}>Add to collection…</Button>
            <Button size="sm" variant="ghost" icon="close" onClick={() => setSelection(emptySelection)}>Clear selection</Button>
          </div>
        )}
        <div className="jb-lib__stage" style={selection.selected.size > 0 ? { height: 'calc(100% - 52px)' } : undefined}>
          {mode === 'home' ? <SearchHome onRun={go} />
            : mode === 'results' && results.isError && !results.data ? <div className="jb-lib__center"><ErrorState title="The search could not be run" detail={results.error instanceof Error ? results.error.message : undefined} onRetry={() => void results.refetch()}>Nothing was changed.</ErrorState></div>
            : mode === 'similar' && notIndexed ? <div className="jb-lib__center"><EmptyState icon="search" title="Not indexed for similarity yet" action={<Button variant="outline" onClick={() => void reindexSearch().then((r) => { toast({ kind: 'ok', title: `${fmtCount(r.embeddingsQueued)} queued for indexing`, body: 'The worker computes them in the background; try again in a moment.' }); })}>Index now</Button>}>This photograph has no visual fingerprint yet. Indexing is local and free; it runs as a background job.</EmptyState></div>
            : mode === 'similar' && similar.isError ? <div className="jb-lib__center"><ErrorState title="Similar photographs could not be loaded" onRetry={() => void similar.refetch()}>Nothing was changed.</ErrorState></div>
            : (mode === 'results' && results.isLoading) || (mode === 'similar' && similar.isLoading) ? (
              <div aria-busy="true" aria-label="Searching" role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignContent: 'flex-start', paddingTop: 4 }}>
                {Array.from({ length: 12 }, (_, i) => <Skeleton key={i} width={`${[22, 14, 18, 26, 16, 20][i % 6]}%`} height={rowHeight * 0.8} />)}
              </div>
            ) : items.length === 0 ? (
              <div className="jb-lib__center"><EmptyState icon="search" title="No photographs match" action={understood.length > 0 ? <Button variant="outline" onClick={() => go(q, [])}>Restore removed phrases</Button> : undefined}>
                Try fewer words, or remove one of the “understood” phrases. The search never guesses beyond what is in your library.</EmptyState></div>
            ) : (
              <PhotoGrid items={items} rowHeight={rowHeight} selection={selection} onSelectionChange={setSelection} onOpen={openAt} label={mode === 'similar' ? 'Similar photographs' : `Search results for ${q}`}
                showScore={auth.settings?.aiScoresVisible} onEndReached={fetchMore} height="100%" activation="select"
                onRate={(i, r) => editOne(items[i]!.id, { rating: r })} onToggleFavorite={(i) => editOne(items[i]!.id, { favorite: !items[i]!.favorite })} onTogglePortfolio={(i) => editOne(items[i]!.id, { portfolio: !items[i]!.portfolio })}
                footer={results.isFetchingNextPage ? 'Loading more…' : mode === 'results' && results.hasNextPage ? ' ' : `End of results · ${fmtCount(items.length)}`} />
            )}
        </div>
      </div>

      <AddToCollection open={collOpen} onOpenChange={setCollOpen} target={{ ids: [...selection.selected] }} count={selection.selected.size} onDone={() => setSelection(emptySelection)} />
      <Dialog open={saveOpen} onOpenChange={setSaveOpen} title="Save this search" description="Only the words and your removed phrases are saved. Results are always computed fresh."
        actions={<><Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button><Button variant="primary" disabled={!saveName.trim()} onClick={() => void doSave()}>Save</Button></>}>
        <Field label="Name" value={saveName} onChange={setSaveName} maxLength={80} autoFocus />
      </Dialog>

      {photoId && viewerItems.length > 0 && (
        <PhotoViewer items={viewerItems} index={index >= 0 ? index : 0}
          onIndexChange={(i) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', viewerItems[i]!.id); return n; }, { replace: true })}
          onClose={closeViewer} detail={detailFor} surface={auth.settings?.viewerSurface ?? 'neutral'} onSurfaceChange={(s) => void auth.updateSettings({ viewerSurface: s })}
          panelOpen={panelOpen} onPanelOpenChange={setPanelOpen}
          onRate={(id, r) => editOne(id, { rating: r })} onFavorite={(id, v) => editOne(id, { favorite: v })} onPortfolio={(id, v) => editOne(id, { portfolio: v })} onNeedMore={fetchMore}
          renderInfoExtras={(p) => <><ViewerActions photoId={p.id} /><PhotoManagement photoId={p.id} /></>} renderAiTab={(p) => <AiPanel photoId={p.id} />} />
      )}
    </div>
  );
}

/** Before anything is typed: saved searches, recent searches, and what the library contains. */
function SearchHome({ onRun }: { onRun: (q: string, exclude?: string[]) => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const saved = useQuery({ queryKey: [...SEARCH_KEY, 'saved'], queryFn: fetchSaved, staleTime: 30_000 });
  const history = useQuery({ queryKey: [...SEARCH_KEY, 'history'], queryFn: fetchHistory, staleTime: 0 });
  const discover = useQuery({ queryKey: [...SEARCH_KEY, 'discover'], queryFn: fetchDiscover, staleTime: 60_000 });
  const fail = () => toast({ kind: 'error', title: 'That could not be done' });
  const d = discover.data;
  return (
    <div className="jb-search__home">
      <section aria-label="Examples"><Label>Try</Label>
        <div className="jb-filter-opts">{(d?.examples ?? ['best photographs never posted', 'five star portrait photos since 2024']).map((e) => <button key={e} type="button" className="jb-opt" onClick={() => onRun(e)}>{e}</button>)}</div>
      </section>
      <section aria-label="Saved searches"><Label>Saved searches</Label>
        {saved.data?.items.length ? (
          <ul className="jb-search__list">{saved.data.items.map((s) => (
            <li key={s.id}><button type="button" className="jb-linkbtn" onClick={() => onRun(s.q, s.exclude)}>{s.name}</button><span className="t-meta"> — {s.q}</span>
              <Button size="sm" variant="ghost" aria-label={`Delete saved search ${s.name}`} onClick={() => void deleteSaved(s.id).then(() => qc.invalidateQueries({ queryKey: [...SEARCH_KEY, 'saved'] })).catch(fail)}>Delete</Button></li>))}</ul>
        ) : <Meta>{saved.isLoading ? 'Loading…' : 'None yet. Run a search, then choose “Save search”.'}</Meta>}
      </section>
      <section aria-label="Recent searches"><Label>Recent searches</Label>
        {history.data?.items.length ? (
          <>
            <ul className="jb-search__list">{history.data.items.map((h) => (
              <li key={h.id}><button type="button" className="jb-linkbtn" onClick={() => onRun(h.q)}>{h.q}</button>{h.resultCount !== null && <span className="t-meta t-num"> — {fmtCount(h.resultCount)}</span>}
                <Button size="sm" variant="ghost" aria-label={`Remove “${h.q}” from history`} onClick={() => void deleteHistory(h.id).then(() => qc.invalidateQueries({ queryKey: [...SEARCH_KEY, 'history'] })).catch(fail)}>Remove</Button></li>))}</ul>
            <Button size="sm" variant="outline" onClick={() => void clearHistory().then(() => qc.invalidateQueries({ queryKey: [...SEARCH_KEY, 'history'] })).catch(fail)}>Clear history</Button>
          </>
        ) : <Meta>{history.isLoading ? 'Loading…' : 'Nothing yet.'}</Meta>}
      </section>
      <section aria-label="Browse by subject"><Label>Species</Label>
        <div className="jb-filter-opts">{d?.species.map((s) => <button key={s.name} type="button" className="jb-opt" onClick={() => onRun(s.name.toLowerCase())}>{s.name}<span className="n">{fmtCount(s.n)}</span></button>)}{d && d.species.length === 0 && <Meta>No species recorded yet.</Meta>}</div>
        <Label>Places</Label>
        <div className="jb-filter-opts">{d?.places.map((s) => <button key={s.name} type="button" className="jb-opt" onClick={() => onRun(s.name)}>{s.name}<span className="n">{fmtCount(s.n)}</span></button>)}{d && d.places.length === 0 && <Meta>No locations recorded yet.</Meta>}</div>
        <Label>Years</Label>
        <div className="jb-filter-opts">{d?.years.map((s) => <button key={s.year} type="button" className="jb-opt" onClick={() => onRun(String(s.year))}>{s.year}<span className="n">{fmtCount(s.n)}</span></button>)}</div>
        <Label>Looks</Label>
        <div className="jb-filter-opts">{d?.tags.map((s) => <button key={s.name} type="button" className="jb-opt" onClick={() => onRun(s.name)}>{s.name}<span className="n">{fmtCount(s.n)}</span></button>)}{d && d.tags.length === 0 && <Meta>Photographs have not been analysed yet.</Meta>}</div>
      </section>
    </div>
  );
}
