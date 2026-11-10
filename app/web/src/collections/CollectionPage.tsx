import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  COLLECTIONS_KEY, KIND_LABEL, deleteCollection, fetchCollection, fetchCollectionPhotos, moveInCollection, patchCollection, removeFromCollection, setCollectionState,
} from '../api/collections';
import { fetchDetail, patchPhoto, type PhotoSet } from '../api/library';
import { useAuth } from '../auth/AuthProvider';
import { useIsPhone, usePersistentState } from '../lib/hooks';
import { emptySelection, type SelectionState } from '../lib/selection';
import { AiPanel } from '../ai/AiPanel';
import { DETAIL_KEY, patchLoaded } from '../library/cache';
import { PhotoManagement } from '../library/PhotoManagement';
import { cardFromDetail, fmtCount, toPhotoItem, toViewerDetail } from '../library/photoMap';
import { ViewerActions } from '../collections/ViewerActions';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/controls';
import { EmptyState, ErrorState, Skeleton, useToast } from '../ui/feedback';
import { PhotoGrid } from '../ui/PhotoGrid';
import { PhotoViewer } from '../ui/PhotoViewer';
import { Meta } from '../ui/typography';
import { AddToCollection } from './AddToCollection';

const PHOTOS = (id: string) => [...COLLECTIONS_KEY, 'photos', id] as const;

export function CollectionPage() {
  const { id = '' } = useParams(); const [sp, setSp] = useSearchParams(); const go = useNavigate();
  const auth = useAuth(); const qc = useQueryClient(); const toast = useToast(); const phone = useIsPhone();
  const meta = useQuery({ queryKey: [...COLLECTIONS_KEY, 'one', id], queryFn: () => fetchCollection(id), retry: false });
  const c = meta.data;
  const photos = useInfiniteQuery({
    queryKey: PHOTOS(id), enabled: !!c, staleTime: 15_000, retry: false,
    queryFn: ({ pageParam }) => fetchCollectionPhotos(id, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const cards = useMemo(() => photos.data?.pages.flatMap((p) => p.items) ?? [], [photos.data]);
  const items = useMemo(() => cards.map(toPhotoItem), [cards]);
  const total = photos.data?.pages[0]?.total ?? c?.count ?? 0;
  const fetchMore = useCallback(() => { if (photos.hasNextPage && !photos.isFetchingNextPage && !photos.isError) void photos.fetchNextPage(); }, [photos]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: COLLECTIONS_KEY }); };
  const failed = (what: string, e?: unknown) => toast({ kind: 'error', title: `${what} failed`, body: e instanceof ApiError ? e.message : 'Nothing was changed.' });

  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const picked = [...selection.selected]; const manual = c?.kind === 'MANUAL';
  const [editOpen, setEditOpen] = useState(false); const [name, setName] = useState(''); const [desc, setDesc] = useState('');
  const [delOpen, setDelOpen] = useState(false); const [addOpen, setAddOpen] = useState(false);

  async function save() {
    try { await patchCollection(id, { name: name.trim(), description: desc.trim() || null }); setEditOpen(false); refresh(); }
    catch (e) { failed('Saving', e); }
  }
  async function remove() { try { await deleteCollection(id); refresh(); toast({ kind: 'ok', title: `“${c?.name}” deleted`, body: 'Its photographs are untouched.' }); go('/collections', { replace: true }); } catch (e) { failed('Deleting', e); } }
  async function removeSelected() { try { const r = await removeFromCollection(id, picked); setSelection(emptySelection); refresh(); toast({ kind: 'ok', title: `${fmtCount(r.removed)} removed from the collection`, body: 'The photographs themselves are untouched.' }); } catch (e) { failed('Removing', e); } }
  async function moveSelected(where: 'start' | 'end') {
    try { await moveInCollection(id, picked, where === 'end' ? null : items.find((i) => !selection.selected.has(i.id))?.id ?? null); void qc.invalidateQueries({ queryKey: PHOTOS(id) }); }
    catch (e) { failed('Moving', e); }
  }
  async function setCover() { try { await patchCollection(id, { coverPhotoId: picked[0]! }); refresh(); toast({ kind: 'ok', title: 'Cover set' }); } catch (e) { failed('Setting the cover', e); } }

  // ---- viewer (?photo=)
  const photoId = sp.get('photo');
  const index = photoId ? items.findIndex((i) => i.id === photoId) : -1;
  const detailQ = useQuery({ queryKey: DETAIL_KEY(photoId ?? ''), queryFn: () => fetchDetail(photoId!), enabled: !!photoId, staleTime: 30_000 });
  const openAt = (i: number) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', items[i]!.id); return n; });
  const closeViewer = () => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('photo'); return n; }, { replace: true });
  const [panelOpen, setPanelOpen] = usePersistentState(`jb-viewer-panel-${phone ? 'phone' : 'desktop'}`, !phone);
  const viewerItems = index >= 0 ? items : detailQ.data ? [toPhotoItem(cardFromDetail(detailQ.data))] : [];
  const detailFor = useCallback((p: (typeof items)[number]) => toViewerDetail(detailQ.data?.id === p.id ? detailQ.data : undefined, p), [detailQ.data]);
  const editOne = useCallback((pid: string, set: PhotoSet) => {
    patchLoaded(qc, (x) => x === pid, set);
    qc.setQueriesData<{ pages: Array<{ items: Array<{ id: string }> }> }>({ queryKey: PHOTOS(id) }, (d) => (d ? { ...d, pages: d.pages.map((pg) => ({ ...pg, items: pg.items.map((it) => (it.id === pid ? { ...it, ...set } : it)) })) } : d));
    patchPhoto(pid, set).catch(() => { void qc.invalidateQueries({ queryKey: PHOTOS(id) }); toast({ kind: 'error', title: 'That change could not be saved' }); });
  }, [qc, toast, id]);

  if (meta.isError) return <div className="jb-page"><EmptyState icon="folder" title="Collection not found" action={<Link className="jb-btn jb-btn--outline" to="/collections">All collections</Link>}>It no longer exists or is not yours to see.</EmptyState></div>;
  const rowHeight = phone ? 150 : (auth.settings?.thumbSize ?? 240);
  return (
    <div className="jb-lib">
      <div className="jb-lib__head">
        <div className="jb-coll__head">
          <div>
            <p className="t-meta"><Link to="/collections">Collections</Link> · {c ? KIND_LABEL[c.kind] : ''}{c?.createdBy === 'AI' ? ' · proposed by AI' : ''}</p>
            <h1 className="t-h2" style={{ margin: 0 }}>{c?.name ?? 'Loading…'}</h1>
            {c?.description && <Meta>{c.description}</Meta>}
            {c?.rationale && <Meta>Why: {c.rationale}</Meta>}
            <Meta>{c ? (c.dynamic ? `${fmtCount(total)} photographs right now — this list is live` : `${fmtCount(total)} photograph${total === 1 ? '' : 's'}`) : ''}</Meta>
          </div>
          <div className="jb-row">
            {c?.status === 'DRAFT' && <Button variant="primary" onClick={() => void setCollectionState(id, 'activate').then(refresh).catch((e) => failed('Activating', e))}>Activate</Button>}
            {c?.status === 'ACTIVE' && c.createdBy === 'AI' && <Button variant="ghost" onClick={() => void setCollectionState(id, 'archive').then(() => { refresh(); go('/collections'); }).catch((e) => failed('Archiving', e))}>Archive</Button>}
            {c?.kind === 'SAVED_SEARCH' && c.search && <Link className="jb-btn jb-btn--outline" to={`/search?${new URLSearchParams([['q', c.search.q], ...c.search.exclude.map((x) => ['x', x] as [string, string])])}`}>Open as a search</Link>}
            <Button variant="outline" onClick={() => { setName(c?.name ?? ''); setDesc(c?.description ?? ''); setEditOpen(true); }} disabled={!c}>Rename</Button>
            <Button variant="ghost" onClick={() => setDelOpen(true)} disabled={!c}>Delete</Button>
          </div>
        </div>
        {c?.kind === 'SMART' && <Meta>A smart collection follows its filters: photographs join and leave on their own. To change the filters, build them in the Library and save again.</Meta>}
      </div>

      <div className="jb-lib__body">
        {picked.length > 0 && (
          <div className="jb-bulk" role="toolbar" aria-label="Collection actions">
            <span className="jb-bulk__count" role="status" aria-live="polite">{fmtCount(picked.length)} selected</span><span className="grow" />
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>Add to another collection…</Button>
            {manual && <>
              <Button size="sm" variant="outline" onClick={() => void moveSelected('start')}>Move to start</Button>
              <Button size="sm" variant="outline" onClick={() => void moveSelected('end')}>Move to end</Button>
              <Button size="sm" variant="outline" disabled={picked.length !== 1} title={picked.length === 1 ? undefined : 'Select one photograph'} onClick={() => void setCover()}>Set as cover</Button>
              <Button size="sm" variant="outline" onClick={() => void removeSelected()}>Remove from collection</Button>
            </>}
            <Button size="sm" variant="ghost" icon="close" onClick={() => setSelection(emptySelection)}>Clear selection</Button>
          </div>
        )}
        <div className="jb-lib__stage" style={picked.length > 0 ? { height: 'calc(100% - 52px)' } : undefined}>
          {photos.isError && !photos.data ? <div className="jb-lib__center"><ErrorState title="The collection could not be loaded" onRetry={() => void photos.refetch()}>Nothing was changed.</ErrorState></div>
            : !c || photos.isLoading ? <div aria-busy="true" role="status" aria-label="Loading photographs" style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingTop: 4 }}>{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} width={`${[22, 14, 18, 26, 16][i % 5]}%`} height={rowHeight * 0.8} />)}</div>
            : items.length === 0 ? <div className="jb-lib__center"><EmptyState icon="folder" title={c.dynamic ? 'Nothing matches right now' : 'This collection is empty'}>{c.dynamic ? 'Photographs will appear as soon as they match.' : 'Select photographs in the Library or Search and choose “Add to collection”, or use “Add to collection” in a photograph’s Information panel.'}</EmptyState></div>
            : <PhotoGrid items={items} rowHeight={rowHeight} selection={selection} onSelectionChange={setSelection} onOpen={openAt} label={`Photographs in ${c.name}`} showScore={auth.settings?.aiScoresVisible}
                onEndReached={fetchMore} height="100%" activation="select" onRate={(i, r) => editOne(items[i]!.id, { rating: r })} onToggleFavorite={(i) => editOne(items[i]!.id, { favorite: !items[i]!.favorite })}
                onTogglePortfolio={(i) => editOne(items[i]!.id, { portfolio: !items[i]!.portfolio })} footer={photos.isFetchingNextPage ? 'Loading more…' : photos.hasNextPage ? ' ' : `End of collection · ${fmtCount(items.length)}`} />}
        </div>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen} title="Rename collection" actions={<><Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>Save</Button></>}>
        <Field label="Name" value={name} onChange={setName} maxLength={80} autoFocus /><Field label="Description (optional)" value={desc} onChange={setDesc} maxLength={500} />
      </Dialog>
      <Dialog open={delOpen} onOpenChange={setDelOpen} title={`Delete “${c?.name ?? ''}”?`} description="Only the collection is deleted. Its photographs stay in your library and in any other collection."
        actions={<><Button variant="ghost" onClick={() => setDelOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => void remove()}>Delete collection</Button></>}><span /></Dialog>
      <AddToCollection open={addOpen} onOpenChange={setAddOpen} target={{ ids: picked }} count={picked.length} onDone={() => setSelection(emptySelection)} />

      {photoId && viewerItems.length > 0 && (
        <PhotoViewer items={viewerItems} index={index >= 0 ? index : 0} onIndexChange={(i) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', viewerItems[i]!.id); return n; }, { replace: true })}
          onClose={closeViewer} detail={detailFor} surface={auth.settings?.viewerSurface ?? 'neutral'} onSurfaceChange={(s) => void auth.updateSettings({ viewerSurface: s })} panelOpen={panelOpen} onPanelOpenChange={setPanelOpen}
          onRate={(pid, r) => editOne(pid, { rating: r })} onFavorite={(pid, v) => editOne(pid, { favorite: v })} onPortfolio={(pid, v) => editOne(pid, { portfolio: v })} onNeedMore={fetchMore}
          renderInfoExtras={(p) => <><ViewerActions photoId={p.id} /><PhotoManagement photoId={p.id} /></>} renderAiTab={(p) => <AiPanel photoId={p.id} />} />
      )}
    </div>
  );
}
