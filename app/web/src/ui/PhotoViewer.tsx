import * as D from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { FIT, MAX_SCALE, panBy, toggleZoom, wheelFactor, zoomAt, type ZoomState } from '../lib/zoom';
import { IconButton } from './Button';
import { Label, Meta } from './typography';
import { StarRating, FavoriteButton } from './StarRating';
import { AiTag, ConfidenceMeter, InstagramStatus, MatchBadge, PortfolioMark, StatusChip, type MatchState } from './status';
import { Tabs } from './Tabs';
import { Button } from './Button';
import type { PhotoItem } from './photo';

export type ViewerSurface = 'teal' | 'neutral';

export interface PhotoDetail {
  info: {
    place?: string; placeSource?: 'EXIF GPS' | 'Folder' | 'You' | 'AI inferred'; capturedAt?: string; notes?: string; version?: string;
    /** extra labelled facts (filename, path, import date, size …) shown under the standard ones */
    rows?: Array<[string, string]>;
  };
  ai: {
    species: Array<{ name: string; scientific?: string; confidence: number; /** confirmed by the photographer: no AI tag or confidence is shown */ confirmed?: boolean }>;
    behavior?: string; habitat?: string; scene?: string; description?: string;
    scores?: Array<{ name: string; value: number }>;
    /** shown instead of the analysis when there is none yet */
    placeholder?: ReactNode;
    /** e.g. "Mock analysis · synthetic data" */
    provenance?: string;
  };
  exif: Array<[string, string]>;
  collections: string[];
  history: Array<{ thumb?: string; date: string; caption: string; link?: string; state?: string }>;
  scheduled?: { when: string; state: 'SCHEDULED' | 'READY' | 'DRAFT' };
  /** Publish tab note, what publishing can do for this photograph right now */
  publishNote?: string;
  loading?: boolean;
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [role="tablist"], [role="radiogroup"], [role="menu"]');
const MATCH_STATES = new Set(['EXACT_MATCH', 'HIGH_CONFIDENCE_MATCH', 'POSSIBLE_MATCH', 'NO_MATCH', 'USER_CONFIRMED', 'USER_REJECTED']);
const isMatchState = (s: string | undefined): s is MatchState => !!s && MATCH_STATES.has(s);
const PAN_STEP = 80;
const ZOOM_STEP = 1.5;

/**
 * Immersive viewer. The photograph is shown with object-fit: contain: never cropped, stretched or filtered.
 * ← → navigate (pan when zoomed) · + − Z zoom · wheel / double-click zoom · drag pans · I panel · N neutral background · F favourite · P portfolio · 0–5 rate · Esc closes.
 */
export function PhotoViewer({ items, index, onIndexChange, onClose, detail, surface, onSurfaceChange, panelOpen, onPanelOpenChange, onRate, onFavorite, onPortfolio, onNeedMore, renderInfoExtras, renderAiTab }: {
  items: readonly PhotoItem[]; index: number; onIndexChange: (i: number) => void; onClose: () => void;
  detail: (p: PhotoItem) => PhotoDetail; surface: ViewerSurface; onSurfaceChange: (s: ViewerSurface) => void;
  panelOpen: boolean; onPanelOpenChange: (o: boolean) => void; onRate?: (id: string, r: number) => void; onFavorite?: (id: string, v: boolean) => void;
  onPortfolio?: (id: string, v: boolean) => void;
  /** called when the viewer is within a few photographs of the end of what is loaded */
  onNeedMore?: () => void;
  /** extra content under the Information tab (editing, versions, duplicates, history) */
  renderInfoExtras?: (p: PhotoItem) => ReactNode;
  /** replaces the content of the AI Analysis tab (the library supplies the live panel) */
  renderAiTab?: (p: PhotoItem) => ReactNode;
}) {
  const p = items[index];
  const filmRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<ZoomState>(FIT);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const drag = useRef<{ x: number; y: number; z: ZoomState } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pid = p?.id;

  useEffect(() => { filmRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' }); }, [index]);
  useEffect(() => { setZoom(FIT); }, [pid]);                                   // every photograph opens fitted
  useEffect(() => { if (index >= items.length - 6) onNeedMore?.(); }, [index, items.length, onNeedMore]);
  useEffect(() => {                                                              // warm the neighbours so ← → feels instant
    for (const n of [items[index + 1], items[index - 1]]) if (n && typeof Image !== 'undefined') new Image().src = n.full ?? n.src;
  }, [index, items]);

  const geometry = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect();
    const cur = items[index];
    return { stage: { w: r?.width ?? 0, h: r?.height ?? 0 }, image: { w: cur?.width ?? 1, h: cur?.height ?? 1 }, left: r?.left ?? 0, top: r?.top ?? 0 };
  }, [items, index]);
  const zoomBy = useCallback((factor: number, at?: { x: number; y: number }) => {
    const g = geometry(); setZoom((z) => zoomAt(z, factor, at ?? { x: 0, y: 0 }, g.stage, g.image));
  }, [geometry]);

  // wheel must be a non-passive native listener to stop the page behind from scrolling
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geometry();
      setZoom((z) => zoomAt(z, wheelFactor(e.deltaY, e.ctrlKey), { x: e.clientX - g.left - g.stage.w / 2, y: e.clientY - g.top - g.stage.h / 2 }, g.stage, g.image));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [geometry, pid]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || zoomRef.current.scale <= 1 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, z: zoomRef.current }; setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current; if (!d) return;
    const g = geometry(); setZoom(panBy(d.z, e.clientX - d.x, e.clientY - d.y, g.stage, g.image));
  };
  const endDrag = (e: ReactPointerEvent) => { if (drag.current) { drag.current = null; setDragging(false); (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } };
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const g = geometry(); setZoom((z) => toggleZoom(z, { x: e.clientX - g.left - g.stage.w / 2, y: e.clientY - g.top - g.stage.h / 2 }, g.stage, g.image));
  };

  if (!p) return null;
  const go = (d: number) => onIndexChange(Math.max(0, Math.min(items.length - 1, index + d)));
  const zoomed = zoom.scale > 1;
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (zoomed && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown')) {     // pan while zoomed
      e.preventDefault(); const g = geometry();
      setZoom((z) => panBy(z, k === 'ArrowLeft' ? PAN_STEP : k === 'ArrowRight' ? -PAN_STEP : 0, k === 'ArrowUp' ? PAN_STEP : k === 'ArrowDown' ? -PAN_STEP : 0, g.stage, g.image));
    }
    else if (k === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomBy(ZOOM_STEP); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); }
    else if (k === 'z' || k === 'Z') { e.preventDefault(); const g = geometry(); setZoom((z) => toggleZoom(z, { x: 0, y: 0 }, g.stage, g.image)); }
    else if (k === 'i' || k === 'I') onPanelOpenChange(!panelOpen);
    else if (k === 'n' || k === 'N') onSurfaceChange(surface === 'teal' ? 'neutral' : 'teal');
    else if (k === 'f' || k === 'F') onFavorite?.(p.id, !p.favorite);
    else if (k === 'p' || k === 'P') onPortfolio?.(p.id, !p.portfolio);
    else if (/^[0-5]$/.test(k)) onRate?.(p.id, Number(k));
  };
  const d = detail(p);
  return (
    <D.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <D.Portal>
        <D.Content className="jb-viewer" data-panel={panelOpen ? 'open' : 'closed'} onKeyDown={onKey} aria-describedby={undefined}
          onEscapeKeyDown={(e) => { if (zoomRef.current.scale > 1) { e.preventDefault(); setZoom(FIT); } }}
          style={{ ['--viewer-surface' as string]: surface === 'neutral' ? '#2e2e2e' : 'var(--abyss-0)' }}>
          <D.Title className="jb-sr-only">{p.title}</D.Title>
          <div className="jb-viewer__stage" ref={stageRef} data-zoomed={zoomed || undefined} data-dragging={dragging || undefined}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={onDoubleClick}>
            <img key={p.id} src={p.full ?? p.src} alt={p.alt} width={p.width} height={p.height} draggable={false}
              style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined} />
            <div className="jb-viewer__bar">
              <D.Close asChild><IconButton icon="close" label="Close viewer (Esc)" /></D.Close>
              <span className="t-meta t-num" style={{ color: 'var(--text-2)' }} aria-live="polite">{index + 1} / {items.length}</span>
              <span className="grow" />
              <span className="jb-viewer__zoom" role="group" aria-label="Zoom">
                <IconButton icon="zoomOut" label="Zoom out (−)" size="sm" disabled={!zoomed} onClick={() => zoomBy(1 / ZOOM_STEP)} />
                <span className="t-meta t-num" aria-live="polite">{Math.round(zoom.scale * 100)}%</span>
                <IconButton icon="zoomIn" label="Zoom in (+)" size="sm" disabled={zoom.scale >= MAX_SCALE} onClick={() => zoomBy(ZOOM_STEP)} />
                <IconButton icon="fit" label="Fit to screen (Z)" size="sm" disabled={!zoomed} onClick={() => setZoom(FIT)} />
              </span>
              <IconButton icon="moon" label={`Background: ${surface === 'neutral' ? 'neutral grey' : 'teal'} (N)`} pressed={surface === 'neutral'} onClick={() => onSurfaceChange(surface === 'teal' ? 'neutral' : 'teal')} />
              <IconButton icon="panel" label="Toggle info panel (I)" pressed={panelOpen} onClick={() => onPanelOpenChange(!panelOpen)} />
            </div>
            <IconButton className="jb-viewer__nav jb-viewer__nav--prev" icon="chevronLeft" label="Previous photograph" disabled={index === 0} onClick={() => go(-1)} />
            <IconButton className="jb-viewer__nav jb-viewer__nav--next" icon="chevronRight" label="Next photograph" disabled={index === items.length - 1} onClick={() => go(1)} />
          </div>
          <div className="jb-viewer__film" ref={filmRef} role="group" aria-label="Photographs in this set">
            {items.slice(Math.max(0, index - 30), index + 31).map((it) => (
              <button key={it.id} type="button" aria-label={it.title} aria-current={it.id === p.id} onClick={() => onIndexChange(items.indexOf(it))}>
                <img src={it.src} alt="" loading="lazy" />
              </button>
            ))}
          </div>
          <aside className="jb-viewer__panel" aria-label="Photograph details">
            <ViewerPanel p={p} d={d} onRate={onRate} onFavorite={onFavorite} onPortfolio={onPortfolio} extras={renderInfoExtras?.(p)} aiTab={renderAiTab?.(p)} />
          </aside>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="jb-section"><Label>{title}</Label>{children}</section>;
}

function ViewerPanel({ p, d, onRate, onFavorite, onPortfolio, extras, aiTab }: { extras?: ReactNode; aiTab?: ReactNode; p: PhotoItem; d: PhotoDetail; onRate?: (id: string, r: number) => void; onFavorite?: (id: string, v: boolean) => void; onPortfolio?: (id: string, v: boolean) => void }) {
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <header style={{ display: 'grid', gap: 8 }}>
        <h2 className="t-h2">{p.species ?? p.title}</h2>
        <Meta>{[p.place, p.capturedAt].filter(Boolean).join(' · ')}</Meta>
        <div className="jb-row" style={{ gap: 10 }}>
          <StarRating value={p.rating} onChange={onRate ? (r) => onRate(p.id, r) : undefined} large />
          <FavoriteButton pressed={p.favorite} onChange={(v) => onFavorite?.(p.id, v)} />
          {onPortfolio
            ? <IconButton icon="pin" size="sm" label="Portfolio candidate (P)" pressed={p.portfolio} onClick={() => onPortfolio(p.id, !p.portfolio)} />
            : p.portfolio && <PortfolioMark />}
          <InstagramStatus state={p.ig.state} count={p.ig.count} showNever />
        </div>
      </header>
      <Tabs label="Photograph panel" defaultValue={new URLSearchParams(window.location.search).get('tab') ?? 'info'} tabs={[
        { value: 'info', label: 'Information', content: (
          <div>
            {!extras && <>
            <Section title="Location">
              <p className="t-body" style={{ color: 'var(--text)' }}>{d.info.place ?? '—'}</p>
              {d.info.placeSource && <Meta>Source: {d.info.placeSource}{d.info.placeSource === 'AI inferred' ? ' — not GPS' : ''}</Meta>}
            </Section>
            <Section title="Capture"><dl className="jb-kv"><dt>Date</dt><dd>{d.info.capturedAt ?? '—'}</dd><dt>Version</dt><dd>{d.info.version ?? '1 of 1'}</dd></dl></Section>
            </>}
            {d.info.rows && d.info.rows.length > 0 && <Section title="File"><dl className="jb-kv">{d.info.rows.map(([k, v]) => <><dt key={k}>{k}</dt><dd key={k + 'v'} style={{ overflowWrap: 'anywhere' }}>{v}</dd></>)}</dl></Section>}
            {!extras && <Section title="Notes"><p className="t-body">{d.info.notes ?? 'No notes.'}</p></Section>}
            {extras}
          </div>) },
        { value: 'ai', label: 'AI Analysis', content: aiTab ?? (
          <div>
            {d.ai.provenance && <Meta>{d.ai.provenance}</Meta>}
            {d.ai.placeholder ? <Section title="Status">{d.ai.placeholder}</Section> : null}
            {d.ai.species.length > 0 && <Section title="Subject">
              {d.ai.species.map((s) => (
                <div key={s.name} className="jb-row" style={{ justifyContent: 'space-between' }}>
                  <div><span style={{ color: 'var(--text)' }}>{s.name}</span> {!s.confirmed && <AiTag />}{s.scientific && <Meta><i>{s.scientific}</i></Meta>}</div>
                  {s.confirmed ? <span className="label-sm" style={{ color: 'var(--text-2)' }}>Confirmed by you</span> : <ConfidenceMeter value={s.confidence} label={s.name} />}
                </div>
              ))}
              {d.ai.species.some((s) => !s.confirmed) && <div className="jb-row"><Button size="sm" variant="outline" icon="check" disabled>Confirm</Button><Button size="sm" variant="ghost" disabled>Correct…</Button></div>}
            </Section>}
            {(d.ai.behavior || d.ai.habitat || d.ai.scene) && <Section title="Scene"><dl className="jb-kv"><dt>Behaviour</dt><dd>{d.ai.behavior ?? '—'}</dd><dt>Habitat</dt><dd>{d.ai.habitat ?? '—'}</dd><dt>Scene</dt><dd>{d.ai.scene ?? '—'}</dd></dl></Section>}
            {d.ai.description && <Section title="Description"><p className="t-body">{d.ai.description} <AiTag /></p></Section>}
            {d.ai.scores && d.ai.scores.length > 0 && <Section title="Curator analysis">{d.ai.scores.map((s) => (
              <div key={s.name} className="jb-row" style={{ justifyContent: 'space-between' }}><span className="t-body">{s.name}</span><ConfidenceMeter value={s.value} label={s.name} /></div>))}</Section>}
          </div>) },
        { value: 'exif', label: 'EXIF', content: <Section title="Camera">{d.exif.length ? <dl className="jb-kv">{d.exif.map(([k, v]) => <><dt key={k}>{k}</dt><dd key={k + 'v'}>{v}</dd></>)}</dl> : <Meta>No EXIF recorded.</Meta>}</Section> },
        { value: 'collections', label: 'Collections', content: (
          <Section title="Member of">{d.collections.length ? d.collections.map((c) => <div key={c} className="jb-row" style={{ justifyContent: 'space-between' }}><span style={{ color: 'var(--text)' }}>{c}</span><Button size="sm" variant="ghost" disabled>Remove</Button></div>) : <Meta>Not in any collection.</Meta>}
            <div><Button size="sm" variant="outline" icon="plus" disabled>Add to collection</Button></div></Section>) },
        { value: 'publish', label: 'Publish', content: (
          <div>
            <Section title="Instagram">
              <InstagramStatus state={p.ig.state} count={p.ig.count} showNever />
              {p.possibleDuplicate && p.ig.state === 'NEVER_POSTED' && <Meta>A possible earlier post is waiting for review in Publish → History.</Meta>}
              {d.scheduled && <div className="jb-row"><StatusChip state={d.scheduled.state} /><span className="t-meta t-num">{d.scheduled.when}</span></div>}
            </Section>
            <Section title="Previous posts">
              {d.history.length ? d.history.map((h) => (
                <div key={h.date + h.caption} style={{ display: 'grid', gridTemplateColumns: h.thumb ? '56px 1fr' : '1fr', gap: 10 }}>
                  {h.thumb && <img src={h.thumb} alt="" style={{ width: 56, height: 70, objectFit: 'cover', borderRadius: 3 }} />}
                  <div><div className="jb-row"><Meta className="t-num">{h.date}</Meta>{isMatchState(h.state) && <MatchBadge state={h.state} />}</div><p className="jb-hist__cap">{h.caption}</p></div>
                </div>)) : <Meta>Never posted.</Meta>}
            </Section>
            {d.publishNote && <Meta>{d.publishNote}</Meta>}
            <div className="jb-row"><Button variant="primary" icon="post" disabled={!!d.publishNote}>Create post</Button><Button variant="outline" icon="compare" disabled={!!d.publishNote}>Find similar</Button></div>
          </div>) },
      ]} />
    </div>
  );
}
