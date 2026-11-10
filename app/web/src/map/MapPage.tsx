import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchClusters, fetchMapSummary, type Cluster } from '../api/map';
import { GPS_LABEL, fetchDetail, locateNamed, fetchPhotos, fromSearchParams, toSearchParams, type GpsFilter, type LibraryQuery } from '../api/library';
import { useAuth } from '../auth/AuthProvider';
import { useToast } from '../ui/feedback';
import { AiPanel } from '../ai/AiPanel';
import { ViewerActions } from '../collections/ViewerActions';
import { DETAIL_KEY } from '../library/cache';
import { PhotoManagement } from '../library/PhotoManagement';
import { cardFromDetail, fmtCount, toPhotoItem, toViewerDetail } from '../library/photoMap';
import { useIsPhone, usePersistentState } from '../lib/hooks';
import { emptySelection, type SelectionState } from '../lib/selection';
import { Button } from '../ui/Button';
import { EmptyState, ErrorState } from '../ui/feedback';
import { PhotoGrid } from '../ui/PhotoGrid';
import { PhotoViewer } from '../ui/PhotoViewer';
import { Label, Meta } from '../ui/typography';
import { BASE, basemapPaths } from './basemap';
import { clampView, fitBbox, formatView, panBy, parseView, project, roundBbox, viewBounds, worldSize, zoomAt, type Bbox, type View } from './geo';

const SOURCES: Array<Exclude<GpsFilter, 'none'>> = ['EXIF', 'IPTC', 'USER_DEFINED', 'GEOCODED', 'FOLDER_DERIVED', 'AI_INFERRED'];
const SOURCE_NOTE: Record<Exclude<GpsFilter, 'none'>, string> = {
  EXIF: 'recorded by the camera', IPTC: 'written into the file’s caption data', USER_DEFINED: 'placed by you', GEOCODED: 'the centre of a place you named — approximate, not the exact spot', FOLDER_DERIVED: 'taken from a folder name', AI_INFERRED: 'suggested by AI — an estimate, not a fact',
};
const DEFAULT_VIEW: View = { lon: 15, lat: 25, zoom: 1.6 };
const FALLBACK = { w: 900, h: 560 };

const dominant = (c: Cluster) => (Object.entries(c.sources) as Array<[Exclude<GpsFilter, 'none'>, number]>).sort((a, b) => b[1] - a[1])[0]![0];
const describe = (c: Cluster) => `${c.count} photograph${c.count === 1 ? '' : 's'} near ${c.lat.toFixed(2)}°, ${c.lon.toFixed(2)}° — ${(Object.entries(c.sources) as Array<[Exclude<GpsFilter, 'none'>, number]>).map(([s, n]) => `${n} ${GPS_LABEL[s]}`).join(', ')}`;

export function MapPage() {
  const [sp, setSp] = useSearchParams(); const auth = useAuth(); const phone = useIsPhone();
  const query = useMemo<LibraryQuery>(() => fromSearchParams(sp), [sp]);
  const filtersKey = useMemo(() => { const p = toSearchParams({ ...query, filters: { ...query.filters, bbox: undefined } }); p.delete('sort'); p.delete('dir'); p.sort(); return p.toString(); }, [query]);
  const photoId = sp.get('photo');
  const qc = useQueryClient(); const toast = useToast();
  // photographs whose typed place name never got a position (typed before lookups existed, or while the service was unreachable): one click looks the names up
  const locate = useMutation({
    mutationFn: locateNamed,
    onSuccess: (r) => {
      for (const k of ['map', 'library', 'collections']) void qc.invalidateQueries({ queryKey: [k] });
      const failed = r.results.filter((x) => x.status !== 'placed');
      toast({ kind: failed.length ? 'warn' : 'ok', title: r.placed ? `${fmtCount(r.placed)} photograph${r.placed === 1 ? '' : 's'} placed on the map` : r.names ? 'No place could be found' : 'Nothing to look up',
        body: `${r.results.filter((x) => x.status === 'placed').map((x) => `${x.query} → ${x.label ?? ''}`).join('; ')}${failed.length ? `${r.placed ? '. ' : ''}Not placed: ${failed.map((x) => `“${x.query}” (${x.status === 'not_found' ? 'not found' : x.status === 'disabled' ? 'lookups are off' : 'service unreachable'})`).join(', ')}. The text was kept.` : ''}. Positions are approximate: the centre of each place.` });
    },
    onError: () => toast({ kind: 'error', title: 'Could not look the places up', body: 'Nothing was changed. Check the connection and try again.' }),
  });

  // ---- the view (centre + zoom); kept in the URL so a map is shareable and survives a refresh
  const box = useRef<HTMLDivElement>(null); const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 50) setSize({ w: Math.round(r.width), h: Math.round(r.height) }); };
    measure(); if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, []);
  const [view, setView] = useState<View>(() => parseView(sp.get('c')) ?? (query.filters.bbox ? fitBbox(query.filters.bbox, FALLBACK.w, FALLBACK.h) : DEFAULT_VIEW));
  const v = useMemo(() => clampView(view, size.w, size.h), [view, size]);
  const [settled, setSettled] = useState(v);
  useEffect(() => { const t = window.setTimeout(() => setSettled(v), 180); return () => window.clearTimeout(t); }, [v]);
  useEffect(() => { setSp((prev) => { const n = new URLSearchParams(prev); n.set('c', formatView(settled)); n.delete('bbox'); return n; }, { replace: true }); }, [settled]);
  const bounds = useMemo<Bbox>(() => roundBbox(viewBounds(settled, size.w, size.h)), [settled, size]);

  // ---- data
  const summary = useQuery({ queryKey: ['map', 'summary', filtersKey], queryFn: () => fetchMapSummary(query), staleTime: 30_000 });
  const clusters = useQuery({
    queryKey: ['map', 'clusters', bounds.join(','), Math.round(settled.zoom), filtersKey], queryFn: () => fetchClusters(query, bounds, settled.zoom),
    placeholderData: keepPreviousData, staleTime: 30_000, retry: false,
  });
  const inView = useInfiniteQuery({
    queryKey: ['map', 'photos', bounds.join(','), filtersKey], staleTime: 30_000, retry: false,
    queryFn: ({ pageParam }) => fetchPhotos({ ...query, sort: 'captured', dir: 'desc', filters: { ...query.filters, bbox: bounds } }, pageParam, 60),
    initialPageParam: undefined as string | undefined, getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const cards = useMemo(() => inView.data?.pages.flatMap((p) => p.items) ?? [], [inView.data]);
  const items = useMemo(() => cards.map(toPhotoItem), [cards]);
  const totalInView = inView.data?.pages[0]?.total;
  const fetchMore = useCallback(() => { if (inView.hasNextPage && !inView.isFetchingNextPage && !inView.isError) void inView.fetchNextPage(); }, [inView]);

  // ---- pointer and keyboard navigation
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onDown = (e: RPointerEvent) => { if ((e.target as Element).closest('[data-cluster]')) return; drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: RPointerEvent) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (!d.moved && Math.hypot(dx, dy) < 3) return; d.moved = true; d.x = e.clientX; d.y = e.clientY; setView((cur) => panBy(clampView(cur, size.w, size.h), dx, dy)); };
  const onUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent) => { const r = (e.currentTarget as Element).getBoundingClientRect(); setView((cur) => zoomAt(clampView(cur, size.w, size.h), size.w, size.h, e.clientX - r.left, e.clientY - r.top, -e.deltaY / 400)); };
  const zoomBy = (d: number) => setView((cur) => zoomAt(clampView(cur, size.w, size.h), size.w, size.h, size.w / 2, size.h / 2, d));
  const onKey = (e: KeyboardEvent) => {
    const step = 60; const k = e.key;
    if (k === 'ArrowLeft') setView((c) => panBy(c, step, 0)); else if (k === 'ArrowRight') setView((c) => panBy(c, -step, 0)); else if (k === 'ArrowUp') setView((c) => panBy(c, 0, step)); else if (k === 'ArrowDown') setView((c) => panBy(c, 0, -step));
    else if (k === '+' || k === '=') zoomBy(1); else if (k === '-' || k === '_') zoomBy(-1); else return;
    e.preventDefault();
  };
  const openCluster = (c: Cluster) => {
    if (c.count === 1) { setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', c.photoId); return n; }); return; }
    const single = c.bbox[0] === c.bbox[2] && c.bbox[1] === c.bbox[3];
    setView(single ? { lon: c.lon, lat: c.lat, zoom: Math.min(18, v.zoom + 3) } : fitBbox(c.bbox, size.w, size.h));
  };

  // ---- provenance filter (legend toggles)
  const gps = query.filters.gps;
  const toggleSource = (g: GpsFilter) => setSp((prev) => { const n = new URLSearchParams(prev); const cur = n.getAll('gps'); n.delete('gps'); (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]).forEach((x) => n.append('gps', x)); return n; }, { replace: true });

  // ---- viewer over the photographs in view
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const index = photoId ? items.findIndex((i) => i.id === photoId) : -1;
  const detailQ = useQuery({ queryKey: DETAIL_KEY(photoId ?? ''), queryFn: () => fetchDetail(photoId!), enabled: !!photoId, staleTime: 30_000 });
  const openAt = (i: number) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', items[i]!.id); return n; });
  const closeViewer = () => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('photo'); return n; }, { replace: true });
  const [panelOpen, setPanelOpen] = usePersistentState(`jb-viewer-panel-${phone ? 'phone' : 'desktop'}`, !phone);
  const viewerItems = index >= 0 ? items : detailQ.data ? [toPhotoItem(cardFromDetail(detailQ.data))] : [];
  const detailFor = useCallback((p: (typeof items)[number]) => toViewerDetail(detailQ.data?.id === p.id ? detailQ.data : undefined, p), [detailQ.data]);

  // ---- drawing
  const [paths, setPaths] = useState<{ land: string; borders: string } | null>(null);
  useEffect(() => { setPaths(basemapPaths()); }, []);
  const k = worldSize(v.zoom) / BASE;
  const [ox, oy] = project(v, size.w, size.h, -180, 85.0511); // top-left of the world in screen px
  const libraryHref = `/library?${new URLSearchParams([...toSearchParams({ ...query, filters: { ...query.filters, bbox: bounds } }).entries()].filter(([key]) => key !== 'c')) }`;
  const s = summary.data; const empty = s !== undefined && s.placed === 0;

  return (
    <div className="jb-map">
      <div className="jb-map__main">
        <h1 className="jb-sr-only">Map</h1>
        <div className="jb-map__surface" ref={box} role="application" aria-label="Map of photograph locations. Arrow keys pan, plus and minus zoom." tabIndex={0} onKeyDown={onKey}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
          <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden={false} focusable="false">
            <rect width={size.w} height={size.h} className="jb-map__sea" />
            {paths && (
              <g transform={`translate(${ox} ${oy}) scale(${k})`} aria-hidden>
                <path d={paths.land} className="jb-map__land" /><path d={paths.borders} className="jb-map__borders" />
              </g>)}
            {(clusters.data?.clusters ?? []).map((c) => {
              const [x, y] = project(v, size.w, size.h, c.lon, c.lat); if (x < -40 || y < -40 || x > size.w + 40 || y > size.h + 40) return null;
              const src = dominant(c); const mixed = Object.keys(c.sources).length > 1; const r = c.count === 1 ? 6 : Math.min(30, 11 + 5 * Math.log10(c.count));
              return (
                <g key={`${c.lat},${c.lon},${c.count}`} data-cluster role="button" tabIndex={0} aria-label={describe(c)} className="jb-map__cluster" transform={`translate(${x} ${y})`}
                  onClick={() => openCluster(c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openCluster(c); } }}>
                  <circle r={r} className="jb-map__dot" data-src={src} data-mixed={mixed || undefined} />
                  {c.count > 1 && <text className="jb-map__count" textAnchor="middle" dy="0.35em">{c.count >= 10000 ? `${Math.round(c.count / 1000)}k` : c.count >= 1000 ? `${(c.count / 1000).toFixed(1)}k` : c.count}</text>}
                </g>);
            })}
          </svg>
          <div className="jb-map__zoom" role="group" aria-label="Zoom">
            <Button size="sm" variant="outline" aria-label="Zoom in" onClick={() => zoomBy(1)}>+</Button>
            <Button size="sm" variant="outline" aria-label="Zoom out" onClick={() => zoomBy(-1)}>−</Button>
            <Button size="sm" variant="outline" aria-label="Show the whole world" onClick={() => setView(DEFAULT_VIEW)}>World</Button>
          </div>
          {clusters.isFetching && <span className="jb-map__busy t-meta" role="status">Updating…</span>}
          {clusters.isError && !clusters.data && <div className="jb-map__error"><ErrorState title="The map could not be loaded" onRetry={() => void clusters.refetch()}>Nothing was changed.</ErrorState></div>}
          {empty && <div className="jb-map__error"><EmptyState icon="map" title="No photographs have coordinates yet">Coordinates come from the camera or the file, from a folder name, or from you: place a pin or type a place name (Information → Edit details) and its centre is looked up — shown as approximate. The map never guesses a position on its own.</EmptyState></div>}
        </div>
        <p className="jb-map__credit t-meta">Outline: Natural Earth (public domain), bundled with the app — no map server is contacted to draw it. Approximate positions come from place names you typed, looked up on OpenStreetMap (© OpenStreetMap contributors; only the typed text is sent).</p>
      </div>

      <aside className="jb-map__side" aria-label="Photographs in view">
        <section aria-label="Legend"><Label>Where the coordinates came from</Label>
          <ul className="jb-map__legend">
            {SOURCES.map((g) => { const n = s?.sources[g] ?? 0; if (!n && !gps.includes(g)) return null; return (
              <li key={g}><button type="button" aria-pressed={gps.includes(g)} onClick={() => toggleSource(g)}>
                <svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6" className="jb-map__dot" data-src={g} /></svg>
                <span>{GPS_LABEL[g]}</span><span className="t-meta t-num">{fmtCount(n)}</span></button><span className="t-meta">{SOURCE_NOTE[g]}</span></li>); })}
          </ul>
          {s && <Meta>{fmtCount(s.placed)} of {fmtCount(s.total)} photographs can be placed. {s.withPlaceNameOnly > 0 && <><Link to="/library?gps=none">{fmtCount(s.withPlaceNameOnly)} have a place name but no coordinates</Link> and are not shown. </>}{s.typedPlaceNameOnly > 0 && <><Button size="sm" variant="outline" icon="map" disabled={locate.isPending} onClick={() => locate.mutate()}>{locate.isPending ? 'Looking up…' : `Put ${fmtCount(s.typedPlaceNameOnly)} on the map`}</Button>{' '}</>}{s.withoutCoordinates - s.withPlaceNameOnly > 0 && `${fmtCount(s.withoutCoordinates - s.withPlaceNameOnly)} have no location at all.`}</Meta>}
          {gps.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('gps'); return n; }, { replace: true })}>Show all sources</Button>}
        </section>
        <section aria-label="In view" className="jb-map__list">
          <div className="jb-row" style={{ justifyContent: 'space-between' }}><Label>In view</Label><Link className="t-meta" to={libraryHref}>Open in Library</Link></div>
          <Meta>{inView.isLoading ? 'Loading…' : totalInView === undefined ? '' : `${fmtCount(totalInView)} photograph${totalInView === 1 ? '' : 's'} in this area`}</Meta>
          <div className="jb-map__grid">
            {items.length > 0 && <PhotoGrid items={items} rowHeight={96} selection={selection} onSelectionChange={setSelection} onOpen={openAt} label="Photographs in the map view" onEndReached={fetchMore} height="100%" activation="open"
              footer={inView.isFetchingNextPage ? 'Loading more…' : inView.hasNextPage ? ' ' : `${fmtCount(items.length)} shown`} />}
            {!inView.isLoading && items.length === 0 && <Meta>Nothing here. Pan or zoom the map.</Meta>}
          </div>
        </section>
      </aside>

      {photoId && viewerItems.length > 0 && (
        <PhotoViewer items={viewerItems} index={index >= 0 ? index : 0} onIndexChange={(i) => setSp((prev) => { const n = new URLSearchParams(prev); n.set('photo', viewerItems[i]!.id); return n; }, { replace: true })}
          onClose={closeViewer} detail={detailFor} surface={auth.settings?.viewerSurface ?? 'neutral'} onSurfaceChange={(sf) => void auth.updateSettings({ viewerSurface: sf })} panelOpen={panelOpen} onPanelOpenChange={setPanelOpen}
          onNeedMore={fetchMore} renderInfoExtras={(p) => <><ViewerActions photoId={p.id} /><PhotoManagement photoId={p.id} /></>} renderAiTab={(p) => <AiPanel photoId={p.id} />} />
      )}
    </div>
  );
}
