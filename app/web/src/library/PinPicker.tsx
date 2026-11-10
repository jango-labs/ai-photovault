import { useEffect, useMemo, useRef, useState } from 'react';
import { BASE, basemapPaths } from '../map/basemap';
import { MAX_ZOOM, clampView, fitBbox, panBy, project, unproject, worldSize, zoomAt, type View } from '../map/geo';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Meta } from '../ui/typography';

const W = 560, H = 340;
export interface Pin { lat: number; lon: number }

/**
 * Place or adjust a pin by hand on the bundled world outline (no map server is contacted). Click to put the pin, drag to move the map, wheel / + / − to zoom.
 * The outline is coarse, so for an exact spot type the coordinates (Latitude / Longitude) — the pin and the fields stay in step.
 */
export function PinPicker({ open, onOpenChange, initial, bbox, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; initial: Pin | null; bbox?: [number, number, number, number] | null; onPick: (p: Pin) => void }) {
  const start = useMemo<View>(() => (bbox ? fitBbox(bbox, W, H, 40) : initial ? { lat: initial.lat, lon: initial.lon, zoom: 6 } : { lat: 20, lon: 0, zoom: 1.4 }), [initial, bbox, open]);
  const [view, setView] = useState<View>(start); const [pin, setPin] = useState<Pin | null>(initial);
  useEffect(() => { if (open) { setView(start); setPin(initial); } }, [open]);
  const v = useMemo(() => clampView(view, W, H), [view]);
  const [paths, setPaths] = useState<{ land: string; borders: string } | null>(null); useEffect(() => { if (open) setPaths(basemapPaths()); }, [open]);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const k = worldSize(v.zoom) / BASE; const [ox, oy] = project(v, W, H, -180, 85.0511);
  const local = (e: React.PointerEvent | React.MouseEvent) => { const r = (e.currentTarget as Element).getBoundingClientRect(); return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height] as const; };
  const place = (x: number, y: number) => { const [lon, lat] = unproject(v, W, H, x, y); setPin({ lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 }); };
  const zoomBy = (d: number) => setView(zoomAt(v, W, H, W / 2, H / 2, d));
  const [px, py] = pin ? project(v, W, H, pin.lon, pin.lat) : [0, 0];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Place the pin" description="Click the map to put the pin where the photograph was taken. Drag to move the map; use + and − to zoom."
      actions={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!pin} onClick={() => { if (pin) { onPick(pin); onOpenChange(false); } }}>Use this position</Button></>}>
      <div className="jb-map__surface" style={{ position: 'relative', width: '100%', maxWidth: W, aspectRatio: `${W} / ${H}`, touchAction: 'none' }} role="application" aria-label="Pin placement map. Click to place the pin, arrow keys move the map, plus and minus zoom."
        tabIndex={0} onKeyDown={(e) => { if (e.key === '+' || e.key === '=') zoomBy(1); else if (e.key === '-') zoomBy(-1); else if (e.key.startsWith('Arrow')) { e.preventDefault(); setView(panBy(v, e.key === 'ArrowLeft' ? 60 : e.key === 'ArrowRight' ? -60 : 0, e.key === 'ArrowUp' ? 60 : e.key === 'ArrowDown' ? -60 : 0)); } else if (e.key === 'Enter') place(W / 2, H / 2); }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (!d.moved && Math.hypot(dx, dy) < 4) return; d.moved = true; d.x = e.clientX; d.y = e.clientY; setView((cur) => panBy(cur, dx, dy)); }}
        onPointerUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved) { const [x, y] = local(e); place(x, y); } }} onWheel={(e) => { const [x, y] = local(e as unknown as React.MouseEvent); setView(zoomAt(v, W, H, x, y, e.deltaY < 0 ? 0.5 : -0.5)); }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" focusable="false" aria-hidden={false}>
          <rect width={W} height={H} className="jb-map__sea" />
          {paths && <g transform={`translate(${ox} ${oy}) scale(${k})`} aria-hidden><path d={paths.land} className="jb-map__land" /><path d={paths.borders} className="jb-map__borders" /></g>}
          {pin && <g data-pin transform={`translate(${px} ${py})`}><circle r={7} className="jb-map__dot" data-src="USER_DEFINED" /><circle r={11} fill="none" stroke="var(--text)" strokeWidth={1.5} /></g>}
        </svg>
        <div className="jb-map__zoom" role="group" aria-label="Zoom"><Button size="sm" variant="outline" aria-label="Zoom in" onClick={() => zoomBy(1)}>+</Button><Button size="sm" variant="outline" aria-label="Zoom out" onClick={() => zoomBy(-1)}>−</Button></div>
      </div>
      <p className="t-meta" role="status">{pin ? `Pin at ${pin.lat.toFixed(5)}°, ${pin.lon.toFixed(5)}° (zoom ${Math.min(MAX_ZOOM, v.zoom).toFixed(1)})` : 'No pin yet.'}</p>
      <Meta>The outline is coarse; for an exact spot, type the coordinates in the form afterwards. The camera’s own coordinates are never replaced — they are kept and can be put back.</Meta>
    </Dialog>
  );
}
