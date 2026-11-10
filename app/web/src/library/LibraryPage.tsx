import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_SORT, GPS_LABEL, SORTS, bulkLocation, SORT_LABEL, VIEWS, VIEW_LABEL, activeFilterCount, bulkUpdate, defaultQuery, emptyFilters, fetchDetail, fetchPhotos, fetchPrefs, fromSearchParams,
  hasLibraryParams, patchPhoto, savePrefs, toFilterBody, toSearchParams, type LibraryFilters, type LibraryQuery, type PhotoSet, type SortDir, type SortKey, type View,
} from '../api/library';
import { useAuth } from '../auth/AuthProvider';
import { useIsPhone, useMediaQuery, usePersistentState } from '../lib/hooks';
import { emptySelection, type SelectionState } from '../lib/selection';
import { Button } from '../ui/Button';
import { ActionMenu, Select } from '../ui/Dropdown';
import { Dialog } from '../ui/Dialog';
import { Field, FilterChip, SegmentedControl, Slider } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { PhotoGrid } from '../ui/PhotoGrid';
import { PhotoViewer } from '../ui/PhotoViewer';
import { DETAIL_KEY, PHOTOS_KEY, patchLoaded } from './cache';
import { FilterPanel } from './FilterPanel';
import { analyseTarget } from '../ai/api';
import { AiPanel } from '../ai/AiPanel';
import { PhotoManagement } from './PhotoManagement';
import { ViewerActions } from '../collections/ViewerActions';
import { AddToCollection } from '../collections/AddToCollection';
import { COLLECTIONS_KEY, createCollection } from '../api/collections';
import { cardFromDetail, fmtCount, toPhotoItem, toViewerDetail } from './photoMap';

const DIR_LABEL: Record<SortKey, [string, string]> = {          // [descending, ascending]
  captured: ['Newest', 'Oldest'], imported: ['Newest', 'Oldest'], modified: ['Newest', 'Oldest'], filename: ['Z–A', 'A–Z'], rating: ['Highest', 'Lowest'],
};
const BULK_CONFIRM_ABOVE = 200;
const PAGE = 120;

function prefsToQuery(p: Awaited<ReturnType<typeof fetchPrefs>> | undefined): LibraryQuery {
  if (!p) return defaultQuery();
  return { view: p.view, sort: p.sort, dir: p.dir, q: '', filters: { ...emptyFilters(), ...p.filters } };
}

interface Sel { explicit: SelectionState; allMatching: boolean; excluded: ReadonlySet<string> }
const noSel: Sel = { explicit: emptySelection, allMatching: false, excluded: new Set() };

export function LibraryPage() {
  const [sp, setSp] = useSearchParams();
  const auth = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const [locDialog, setLocDialog] = useState(false);
  const [locValue, setLocValue] = useState('');
  const touch = useMediaQuery('(pointer: coarse)');          // touch: tap opens; a Select mode makes taps toggle selection
  const [selecting, setSelecting] = useState(false);

  // ---- the query: the URL is the source of truth; saved preferences apply when the URL carries none
  const prefsQ = useQuery({ queryKey: ['library', 'prefs'], queryFn: fetchPrefs, staleTime: Infinity, retry: false });
  const urlHas = hasLibraryParams(sp);
  const ready = urlHas || !prefsQ.isLoading;
  const query = useMemo<LibraryQuery>(() => (urlHas ? fromSearchParams(sp) : prefsToQuery(prefsQ.data)), [urlHas, sp, prefsQ.data]);
  const qKey = toSearchParams(query).toString();
  const changed = useRef(false);
  const setQuery = useCallback((next: LibraryQuery) => {
    changed.current = true;
    setSel(noSel);
    setSp(toSearchParams(next), { replace: true });
  }, [setSp]);
  const patchQuery = (p: Partial<LibraryQuery>) => setQuery({ ...query, ...p });

  // preferences are saved shortly after the user changes something (never on first load)
  useEffect(() => {
    if (!changed.current) return;
    const t = window.setTimeout(() => {
      const { view, q: _q, ...filters } = toFilterBody(query);
      void savePrefs({ view, sort: query.sort, dir: query.dir, filters: filters as Partial<LibraryFilters> }).catch(() => { /* preferences are a convenience */ });
    }, 800);
    return () => window.clearTimeout(t);
  }, [qKey]);

  // ---- the photographs: PostgreSQL filters, sorts and pages; the browser only holds what has been scrolled into view
  const photos = useInfiniteQuery({
    queryKey: [...PHOTOS_KEY, qKey], enabled: ready, staleTime: 60_000, gcTime: 5 * 60_000,
    queryFn: ({ pageParam }) => fetchPhotos(query, pageParam, PAGE),
    initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const cards = useMemo(() => photos.data?.pages.flatMap((p) => p.items) ?? [], [photos.data]);
  const items = useMemo(() => cards.map(toPhotoItem), [cards]);
  const total = photos.data?.pages[0]?.total;
  const filterCount = activeFilterCount(query.filters) + (query.q ? 1 : 0);
  const fetchMore = useCallback(() => { if (photos.hasNextPage && !photos.isFetchingNextPage && !photos.isError) void photos.fetchNextPage(); }, [photos]);

  // ---- selection (explicit, or "everything matching the filters except these")
  const [sel, setSel] = useState<Sel>(noSel);
  const gridSelection = useMemo<SelectionState>(() => (
    sel.allMatching ? { selected: new Set(items.filter((i) => !sel.excluded.has(i.id)).map((i) => i.id)), anchor: sel.explicit.anchor } : sel.explicit
  ), [sel, items]);
  const onSelectionChange = useCallback((s: SelectionState) => {
    setSel((cur) => cur.allMatching
      ? { ...cur, explicit: { ...cur.explicit, anchor: s.anchor }, excluded: new Set([...cur.excluded].filter((id) => !items.some((i) => i.id === id)).concat(items.filter((i) => !s.selected.has(i.id)).map((i) => i.id))) }
      : { ...cur, explicit: s });
  }, [items]);
  const selectedCount = sel.allMatching ? Math.max(0, (total ?? 0) - sel.excluded.size) : sel.explicit.selected.size;
  const allLoadedSelected = !sel.allMatching && items.length > 0 && sel.explicit.selected.size === items.length;
  const canSelectEverything = (total ?? 0) > items.length && (allLoadedSelected || sel.explicit.selected.size > 0);
  const clearSel = () => setSel(noSel);

  // ---- editing (optimistic, server-confirmed)
  const failed = (what: string) => { void qc.invalidateQueries({ queryKey: ['library'] }); toast({ kind: 'error', title: `${what} could not be saved`, body: 'Your change was reverted. Check the connection and try again.' }); };
  const editOne = useCallback((id: string, set: PhotoSet) => {
    patchLoaded(qc, (x) => x === id, set);
    patchPhoto(id, set).catch(() => failed('That change'));
  }, [qc]);
  /** keyboard/viewer edit: applies to the whole selection when the target is part of a multi-selection */
  const editAt = (id: string, set: PhotoSet) => {
    const inMulti = selectedCount > 1 && (sel.allMatching ? !sel.excluded.has(id) : sel.explicit.selected.has(id));
    if (inMulti) void runBulk(set, true); else editOne(id, set);
  };

  const [confirm, setConfirm] = useState<{ set: PhotoSet; what: string } | null>(null);
  const describe = (set: PhotoSet) => set.rating !== undefined ? (set.rating ? `set the rating to ${set.rating}` : 'clear the rating') : set.favorite !== undefined ? (set.favorite ? 'mark as favourite' : 'remove from favourites') : set.hidden !== undefined ? (set.hidden ? 'hide' : 'restore') : set.portfolio ? 'add to the portfolio' : 'remove from the portfolio';
  const requestBulk = (set: PhotoSet) => {
    if (selectedCount > BULK_CONFIRM_ABOVE || sel.allMatching) setConfirm({ set, what: describe(set) }); else void runBulk(set, false);
  };
  async function runBulk(set: PhotoSet, quiet: boolean) {
    setConfirm(null);
    try {
      if (sel.allMatching) {
        if (sel.excluded.size > 1000) { toast({ kind: 'warn', title: 'Too many exclusions', body: 'Deselect fewer than 1,000 photographs, or narrow the filters.' }); return; }
        patchLoaded(qc, (id) => !sel.excluded.has(id), set);
        const r = await bulkUpdate({ query: toFilterBody(query), exclude: [...sel.excluded] }, set);
        void qc.resetQueries({ queryKey: PHOTOS_KEY });
        toast({ kind: 'ok', title: `${fmtCount(r.updated)} photographs updated` });
      } else {
        const ids = [...sel.explicit.selected];
        patchLoaded(qc, (id) => sel.explicit.selected.has(id), set);
        let updated = 0;
        for (let i = 0; i < ids.length; i += 500) updated += (await bulkUpdate({ ids: ids.slice(i, i + 500) }, set)).updated;
        if (!quiet) toast({ kind: 'ok', title: `${fmtCount(updated)} photograph${updated === 1 ? '' : 's'} updated` });
      }
    } catch { failed('The bulk change'); }
  }

  async function runBulkLocation() {
    setLocDialog(false);
    const location = locValue.trim() || null;
    try {
      const r = sel.allMatching ? await bulkLocation({ query: toFilterBody(query), exclude: [...sel.excluded] }, location) : await bulkLocation({ ids: [...sel.explicit.selected].slice(0, 500) }, location);
      void qc.resetQueries({ queryKey: PHOTOS_KEY }); void qc.invalidateQueries({ queryKey: ['library', 'facets'] }); void qc.invalidateQueries({ queryKey: ['map'] }); void qc.invalidateQueries({ queryKey: ['collections'] });
      const g = r.geocode; const note = g?.status === 'placed' ? `${fmtCount(r.positioned)} placed on the map near ${g.label ?? 'that place'} (approximate: the centre of the place). Photographs with an exact position were left alone.` : g?.message ?? 'Recorded in each photograph’s edit history (undo from the viewer).';
      toast({ kind: g && (g.status === 'not_found' || g.status === 'unavailable' || g.status === 'disabled') ? 'warn' : 'ok', title: `Location set on ${fmtCount(r.updated)} photograph${r.updated === 1 ? '' : 's'}`, body: note });
    } catch { failed('The location change'); }
  }
  async function runAnalyse() {
    try {
      const r = await analyseTarget(sel.allMatching ? { query: toFilterBody(query), exclude: [...sel.excluded] } : { ids: [...sel.explicit.selected].slice(0, 1000) });
      void qc.invalidateQueries({ queryKey: ['library'] });
      toast({ kind: 'ok', title: `${fmtCount(r.queued)} queued for analysis`, body: `${fmtCount(r.alreadyAnalysed)} already analysed${r.waitingForPreviews ? `, ${fmtCount(r.waitingForPreviews)} waiting for previews` : ''}. The worker does the rest.` });
    } catch { failed('Queuing the analysis'); }
  }
  // ---- collections: add the selection to one, or save the current filters as a smart collection
  const [collOpen, setCollOpen] = useState(false); const [smartOpen, setSmartOpen] = useState(false); const [smartName, setSmartName] = useState('');
  const collTarget = sel.allMatching ? { query: toFilterBody(query), exclude: [...sel.excluded] } : { ids: [...sel.explicit.selected] };
  async function saveSmart() {
    try {
      const r = await createCollection({ name: smartName.trim(), kind: 'SMART', filters: toFilterBody(query) });
      setSmartOpen(false); setSmartName(''); void qc.invalidateQueries({ queryKey: COLLECTIONS_KEY });
      toast({ kind: 'ok', title: 'Smart collection saved', body: 'It follows these filters: photographs join and leave on their own.' }); navigate(`/collections/${r.id}`);
    } catch { toast({ kind: 'error', title: 'The smart collection could not be saved', body: 'The name may already be used.' }); }
  }
  const canCompare = !sel.allMatching && sel.explicit.selected.size >= 2 && sel.explicit.selected.size <= 4;

  // ---- viewer (deep-linkable: ?photo=<id>)
  const photoId = sp.get('photo');
  const index = photoId ? items.findIndex((i) => i.id === photoId) : -1;
  const detailQ = useQuery({ queryKey: DETAIL_KEY(photoId ?? ''), queryFn: () => fetchDetail(photoId!), enabled: !!photoId, staleTime: 30_000 });
  const openAt = (i: number) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', items[i]!.id); return n; });
  const closeViewer = () => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('photo'); return n; }, { replace: true });
  const [panelOpen, setPanelOpen] = usePersistentState(`jb-viewer-panel-${phone ? 'phone' : 'desktop'}`, !phone);
  const viewerSurface = auth.settings?.viewerSurface ?? 'neutral';
  const viewerItems = index >= 0 ? items : detailQ.data ? [toPhotoItem(cardFromDetail(detailQ.data))] : [];
  const viewerIndex = index >= 0 ? index : 0;
  const detailFor = useCallback((p: (typeof items)[number]) => toViewerDetail(detailQ.data?.id === p.id ? detailQ.data : undefined, p), [detailQ.data]);

  // ---- thumbnail size (a saved display setting)
  const savedSize = auth.settings?.thumbSize ?? 240;
  const [size, setSize] = useState(savedSize);
  useEffect(() => { setSize(savedSize); }, [savedSize]);
  const sizeTimer = useRef<number | undefined>(undefined);
  const changeSize = (v: number) => { setSize(v); window.clearTimeout(sizeTimer.current); sizeTimer.current = window.setTimeout(() => { void auth.updateSettings({ thumbSize: v }); }, 500); };
  useEffect(() => () => window.clearTimeout(sizeTimer.current), []);
  const rowHeight = phone ? Math.min(size, 160) : size;

  // ---- filters UI
  const [filtersOpen, setFiltersOpen] = useState(false);
  const chips = useMemo(() => buildChips(query, patchQuery), [query]);
  const [dirLabelDesc, dirLabelAsc] = DIR_LABEL[query.sort];
  const loadFailed = photos.isError && !photos.data;          // first page failed: nothing to show
  const moreFailed = photos.isError && !!photos.data;         // a later page failed: keep what is on screen
  const emptyLibrary = !photos.isLoading && !loadFailed && total === 0 && filterCount === 0 && query.view === 'all';
  const setView = (v: View) => setQuery({ ...query, view: v, ...DEFAULT_SORT[v] });

  return (
    <div className="jb-lib">
      <div className="jb-lib__head">
        <h1 className="jb-sr-only">Library</h1>
        <nav className="jb-lib__views" aria-label="Library views">
          {VIEWS.map((v) => <button key={v} type="button" aria-current={v === query.view} onClick={() => setView(v)}>{VIEW_LABEL[v]}</button>)}
        </nav>
        <div className="jb-lib__tools">
          <Select label="Sort" value={query.sort} onChange={(s) => patchQuery({ sort: s, dir: s === 'filename' ? 'asc' : 'desc' })}
            options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))} />
          <SegmentedControl<SortDir> label="Sort direction" value={query.dir} onChange={(dir) => patchQuery({ dir })} options={[{ value: 'desc', label: dirLabelDesc }, { value: 'asc', label: dirLabelAsc }]} />
          <Button variant="outline" icon="filter" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog">Filters{filterCount > 0 && <span className="t-num" style={{ color: 'var(--aqua)' }}> {filterCount}<span className="jb-sr-only"> active</span></span>}</Button>
          {touch && <Button variant={selecting ? 'outline' : 'ghost'} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); if (selecting) clearSel(); }}>{selecting ? 'Done' : 'Select'}</Button>}
          <Link className="jb-btn jb-btn--ghost" to="/library/duplicates">Duplicates</Link>
          <Link className="jb-btn jb-btn--ghost" to={`/map?${toSearchParams({ ...query, sort: 'captured', dir: 'desc' })}`}>On map</Link>
          <Button variant="ghost" onClick={() => setSel({ ...noSel, allMatching: true })} disabled={!total}>Select all{total ? ` ${fmtCount(total)}` : ''}</Button>
          <span className="grow" />
          <span className="jb-lib__count t-num" role="status" aria-live="polite">{photos.isLoading ? 'Loading…' : total !== undefined ? `${fmtCount(total)} photograph${total === 1 ? '' : 's'}` : ''}</span>
          <span className="jb-lib__size"><Slider label="Size" value={size} min={120} max={420} step={10} onChange={changeSize} format={(v) => `${v}px`} /></span>
        </div>
        {chips.length > 0 && (
          <div className="jb-lib__chips" role="group" aria-label="Active filters">
            {chips.map((c) => <FilterChip key={c.key} name={c.name} value={c.value} onRemove={c.remove} />)}
            <Button size="sm" variant="ghost" onClick={() => setQuery({ ...query, q: '', filters: emptyFilters() })}>Clear all</Button>
            <Button size="sm" variant="outline" onClick={() => { setSmartName(''); setSmartOpen(true); }}>Save as smart collection…</Button>
          </div>
        )}
      </div>

      <div className="jb-lib__body">
        {selectedCount > 0 && (
          <div className="jb-bulk" role="toolbar" aria-label="Bulk actions">
            <span className="jb-bulk__count" role="status" aria-live="polite">{fmtCount(selectedCount)} selected</span>
            {canSelectEverything && <Button size="sm" variant="ghost" onClick={() => setSel({ ...noSel, allMatching: true })}>Select all {fmtCount(total!)} matching</Button>}
            <span className="grow" />
            <ActionMenu label="Set rating" trigger={<Button size="sm" variant="outline" icon="star">Rate</Button>}
              items={[5, 4, 3, 2, 1, 0].map((r) => ({ label: r === 0 ? 'No rating' : `${r} star${r > 1 ? 's' : ''}`, onSelect: () => requestBulk({ rating: r }) }))} />
            <Button size="sm" variant="outline" icon="heart" onClick={() => requestBulk({ favorite: true })}>Favourite</Button>
            <Button size="sm" variant="ghost" onClick={() => requestBulk({ favorite: false })}>Unfavourite</Button>
            <Button size="sm" variant="outline" icon="pin" onClick={() => requestBulk({ portfolio: true })}>Add to portfolio</Button>
            <Button size="sm" variant="ghost" onClick={() => requestBulk({ portfolio: false })}>Remove from portfolio</Button>
            <Button size="sm" variant="outline" onClick={() => { setLocValue(''); setLocDialog(true); }}>Set location…</Button>
            {query.filters.hidden ? <Button size="sm" variant="outline" onClick={() => requestBulk({ hidden: false })}>Restore</Button> : <Button size="sm" variant="ghost" onClick={() => requestBulk({ hidden: true })}>Hide</Button>}
            <Button size="sm" variant="outline" onClick={() => setCollOpen(true)}>Add to collection…</Button>
            <Button size="sm" variant="outline" onClick={() => void runAnalyse()}>Analyse</Button>
            <Button size="sm" variant="outline" icon="compare" disabled={!canCompare} title={canCompare ? 'Compare side by side' : 'Select 2–4 photographs to compare'} onClick={() => navigate(`/library/compare?ids=${[...sel.explicit.selected].join(',')}`)}>Compare</Button>
            <Button size="sm" variant="ghost" icon="close" onClick={clearSel}>Clear selection</Button>
          </div>
        )}

        <div className="jb-lib__stage" style={selectedCount > 0 ? { height: 'calc(100% - 52px)' } : undefined}>
          {loadFailed ? (
            <div className="jb-lib__center"><ErrorState title="The library could not be loaded" detail={photos.error instanceof Error ? photos.error.message : undefined} onRetry={() => void photos.refetch()}>Nothing was changed. Check that this computer is reachable and try again.</ErrorState></div>
          ) : !ready || photos.isLoading ? (
            <div aria-busy="true" aria-label="Loading photographs" role="status" style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignContent: 'flex-start', paddingTop: 4 }}>
              {Array.from({ length: 18 }, (_, i) => <Skeleton key={i} width={`${[22, 14, 18, 26, 16, 20][i % 6]}%`} height={rowHeight * 0.8} />)}
            </div>
          ) : emptyLibrary ? (
            <div className="jb-lib__center"><EmptyState icon="library" title="Your library is empty">No photographs have been imported yet. Import is built in Phase 7 and starts only when you approve it — nothing on this computer has been scanned.</EmptyState></div>
          ) : items.length === 0 ? (
            <div className="jb-lib__center"><EmptyState icon="search" title="No photographs match" action={<Button variant="outline" onClick={() => setQuery({ ...defaultQuery(), view: query.view, sort: query.sort, dir: query.dir })}>Clear filters</Button>}>
              {query.view !== 'all' ? `Nothing in “${VIEW_LABEL[query.view]}” matches these filters.` : 'Try removing a filter or changing the search.'}</EmptyState></div>
          ) : (
            <PhotoGrid items={items} rowHeight={rowHeight} selection={gridSelection} onSelectionChange={onSelectionChange} onOpen={openAt} label={`Photographs: ${VIEW_LABEL[query.view]}`}
              showScore={auth.settings?.aiScoresVisible} onEndReached={fetchMore} height="100%" activation={touch ? (selecting ? 'toggle' : 'open') : 'select'}
              onRate={(i, r) => editAt(items[i]!.id, { rating: r })} onToggleFavorite={(i) => editAt(items[i]!.id, { favorite: !items[i]!.favorite })} onTogglePortfolio={(i) => editAt(items[i]!.id, { portfolio: !items[i]!.portfolio })}
              footer={photos.isFetchingNextPage ? 'Loading more…' : moreFailed ? <Button size="sm" variant="outline" onClick={() => void photos.refetch()}>Could not load more — retry</Button> : photos.hasNextPage ? ' ' : `End of results · ${fmtCount(items.length)}`} />
          )}
        </div>
      </div>

      <FilterPanel open={filtersOpen} onOpenChange={setFiltersOpen} filters={query.filters} onChange={(filters) => patchQuery({ filters })} onClear={() => patchQuery({ filters: emptyFilters() })} />

      <AddToCollection open={collOpen} onOpenChange={setCollOpen} target={collTarget} count={selectedCount} />
      <Dialog open={smartOpen} onOpenChange={setSmartOpen} title="Save as smart collection" description="A smart collection stores these filters, not the photographs: whatever matches is always up to date."
        actions={<><Button variant="ghost" onClick={() => setSmartOpen(false)}>Cancel</Button><Button variant="primary" disabled={!smartName.trim()} onClick={() => void saveSmart()}>Save</Button></>}>
        <Field label="Name" value={smartName} onChange={setSmartName} maxLength={80} autoFocus />
      </Dialog>
      <Dialog open={locDialog} onOpenChange={setLocDialog} title={`Set the location of ${fmtCount(selectedCount)} photograph${selectedCount === 1 ? '' : 's'}`}
        description="The name is stored as yours (provenance “You”) and recorded in each photograph’s edit history. Leave it empty to clear the location. Photograph files are never touched."
        actions={<><Button variant="ghost" onClick={() => setLocDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => void runBulkLocation()}>{locValue.trim() ? 'Set location' : 'Clear location'}</Button></>}>
        <Field label="Location" value={locValue} onChange={setLocValue} maxLength={120} autoFocus />
      </Dialog>

      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={`Apply to ${fmtCount(selectedCount)} photographs?`}
        description={confirm ? `This will ${confirm.what} for ${fmtCount(selectedCount)} photographs${sel.allMatching ? ' matching the current filters' : ''}. Only your catalogue is changed; photograph files are never touched.` : undefined}
        actions={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" onClick={() => confirm && void runBulk(confirm.set, false)}>Apply</Button></>} />

      {photoId && viewerItems.length > 0 && (
        <PhotoViewer items={viewerItems} index={viewerIndex}
          onIndexChange={(i) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', viewerItems[i]!.id); return n; }, { replace: true })}
          onClose={closeViewer} detail={detailFor} surface={viewerSurface} onSurfaceChange={(s) => void auth.updateSettings({ viewerSurface: s })}
          panelOpen={panelOpen} onPanelOpenChange={setPanelOpen}
          onRate={(id, r) => editOne(id, { rating: r })} onFavorite={(id, v) => editOne(id, { favorite: v })} onPortfolio={(id, v) => editOne(id, { portfolio: v })} onNeedMore={fetchMore} renderInfoExtras={(p) => <><ViewerActions photoId={p.id} /><PhotoManagement photoId={p.id} /></>} renderAiTab={(p) => <AiPanel photoId={p.id} />} />
      )}
      {photoId && index < 0 && detailQ.isError && (
        <Dialog open onOpenChange={() => closeViewer()} title="Photograph not found" description="This photograph no longer exists or is not yours to see." actions={<Button onClick={closeViewer}>Back to the library</Button>} />
      )}
    </div>
  );
}

function buildChips(q: LibraryQuery, patch: (p: Partial<LibraryQuery>) => void) {
  const f = q.filters; const set = (p: Partial<LibraryFilters>) => patch({ filters: { ...f, ...p } });
  const out: Array<{ key: string; name: string; value: string; remove: () => void }> = [];
  if (q.q) out.push({ key: 'q', name: 'Search', value: q.q, remove: () => patch({ q: '' }) });
  f.year.forEach((y) => out.push({ key: `y${y}`, name: 'Year taken', value: String(y), remove: () => set({ year: f.year.filter((x) => x !== y) }) }));
  f.folderYear.forEach((y) => out.push({ key: `fy${y}`, name: 'Folder year', value: String(y), remove: () => set({ folderYear: f.folderYear.filter((x) => x !== y) }) }));
  f.folder.forEach((d) => out.push({ key: `fd${d}`, name: 'Folder', value: d, remove: () => set({ folder: f.folder.filter((x) => x !== d) }) }));
  f.month.forEach((m) => out.push({ key: `mo${m}`, name: 'Month', value: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]!, remove: () => set({ month: f.month.filter((x) => x !== m) }) }));
  f.country.forEach((c) => out.push({ key: `c${c}`, name: 'Country', value: c, remove: () => set({ country: f.country.filter((x) => x !== c) }) }));
  f.state.forEach((c) => out.push({ key: `st${c}`, name: 'State', value: c, remove: () => set({ state: f.state.filter((x) => x !== c) }) }));
  f.city.forEach((c) => out.push({ key: `ci${c}`, name: 'City', value: c, remove: () => set({ city: f.city.filter((x) => x !== c) }) }));
  f.location.forEach((l) => out.push({ key: `l${l}`, name: 'Folder location', value: l, remove: () => set({ location: f.location.filter((x) => x !== l) }) }));
  f.rating.forEach((r) => out.push({ key: `r${r}`, name: 'Rating', value: r === 0 ? 'Unrated' : `${r}★`, remove: () => set({ rating: f.rating.filter((x) => x !== r) }) }));
  if (f.hidden) out.push({ key: 'hid', name: 'Show', value: 'hidden only', remove: () => set({ hidden: undefined }) });
  f.dup.forEach(() => out.push({ key: 'dup', name: 'Duplicates', value: 'to review', remove: () => set({ dup: [] }) }));
  if (f.favorite !== undefined) out.push({ key: 'fav', name: 'Favourites', value: f.favorite ? 'Yes' : 'No', remove: () => set({ favorite: undefined }) });
  if (f.portfolio !== undefined) out.push({ key: 'port', name: 'Portfolio', value: f.portfolio ? 'Yes' : 'No', remove: () => set({ portfolio: undefined }) });
  f.orientation.forEach((o) => out.push({ key: `o${o}`, name: 'Orientation', value: o, remove: () => set({ orientation: f.orientation.filter((x) => x !== o) }) }));
  f.ig.forEach((g) => out.push({ key: `g${g}`, name: 'Instagram', value: g === 'possible' ? 'possible duplicate' : g === 'posted' ? 'published' : g === 'never' ? 'never published' : g, remove: () => set({ ig: f.ig.filter((x) => x !== g) }) }));
  f.ai.forEach((a) => out.push({ key: `a${a}`, name: 'AI', value: a === 'none' ? 'not analysed' : a === 'analyzed' ? 'analysed' : a, remove: () => set({ ai: f.ai.filter((x) => x !== a) }) }));
  f.camera.forEach((c) => out.push({ key: `c${c}`, name: 'Camera', value: c, remove: () => set({ camera: f.camera.filter((x) => x !== c) }) }));
  if (f.bbox) out.push({ key: 'bbox', name: 'Map area', value: `${f.bbox[1].toFixed(2)}…${f.bbox[3].toFixed(2)}°, ${f.bbox[0].toFixed(2)}…${f.bbox[2].toFixed(2)}°`, remove: () => set({ bbox: undefined }) });
  f.gps.forEach((g) => out.push({ key: `gps${g}`, name: 'Coordinates', value: GPS_LABEL[g], remove: () => set({ gps: f.gps.filter((x) => x !== g) }) }));
  f.lens.forEach((l) => out.push({ key: `n${l}`, name: 'Lens', value: l, remove: () => set({ lens: f.lens.filter((x) => x !== l) }) }));
  return out;
}
