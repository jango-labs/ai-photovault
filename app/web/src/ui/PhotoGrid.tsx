import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { justifiedLayout, rowOfIndex, verticalNeighbour } from '../lib/justified';
import { applyClick, emptySelection, selectAll, toggleOne, type SelectionState } from '../lib/selection';
import { useElementWidth } from '../lib/hooks';
import type { PhotoItem } from './photo';
import { Thumbnail, type OverlayMode } from './Thumbnail';

export interface PhotoGridProps {
  items: readonly PhotoItem[];
  /** target row height in px (the user-adjustable thumbnail size) */
  rowHeight: number;
  gap?: number;
  overlay?: OverlayMode;
  showScore?: boolean;
  selection: SelectionState;
  onSelectionChange: (s: SelectionState) => void;
  onOpen: (index: number) => void;
  onRate?: (index: number, rating: number) => void;
  onToggleFavorite?: (index: number) => void;
  onTogglePortfolio?: (index: number) => void;
  /** called when the last rows scroll into view (infinite loading from the server) */
  onEndReached?: () => void;
  /** what a click/tap does: select (mouse default), open (touch default) or toggle (touch "Select" mode) */
  activation?: 'select' | 'open' | 'toggle';
  /** shown under the last row ("Loading more…", "End of results") */
  footer?: ReactNode;
  label?: string;
  /** CSS height of the scroll area. In the app the grid fills the viewport; the showcase uses a fixed height. */
  height?: number | string;
}

/**
 * Virtualised, justified contact sheet. Only the visible rows exist in the DOM (so 100,000 photographs cost the same as 100).
 * Accessibility: a single tab stop (listbox with aria-activedescendant); arrows/Home/End/PageUp/PageDown move, Shift extends,
 * Space toggles, Enter opens, Ctrl/⌘+A selects all, Esc clears, 0–5 rates, F favourites.
 */
export function PhotoGrid({ items, rowHeight, gap = 3, overlay = 'hover', showScore, selection, onSelectionChange, onOpen, onRate, onToggleFavorite, onTogglePortfolio, onEndReached, activation = 'select', footer, label = 'Photographs', height = '100%' }: PhotoGridProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const idBase = useId().replace(/:/g, '');
  const [active, setActive] = useState(0);
  const ids = useMemo(() => items.map((p) => p.id), [items]);
  const aspects = useMemo(() => Float32Array.from(items, (p) => p.width / p.height), [items]);
  const layout = useMemo(() => justifiedLayout(aspects, width, rowHeight, gap), [aspects, width, rowHeight, gap]);
  const virt = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => wrapRef.current,
    estimateSize: (i) => (layout.rows[i]?.height ?? rowHeight) + gap,
    overscan: 3,
  });
  // heights change with width/size: tell the virtualizer
  useEffect(() => { virt.measure(); }, [layout, virt]);

  // infinite loading: ask for more when the last rows are within reach
  const virtItems = virt.getVirtualItems();
  const lastVisible = virtItems.length ? virtItems[virtItems.length - 1]!.index : -1;
  useEffect(() => { if (lastVisible >= 0 && lastVisible >= layout.rows.length - 4) onEndReached?.(); }, [lastVisible, layout.rows.length, onEndReached]);

  // when the data set is replaced (new filter / sort) the active cell must exist and the view returns to the top
  const firstId = items[0]?.id;
  useEffect(() => { setActive(0); wrapRef.current?.scrollTo?.({ top: 0 }); }, [firstId, wrapRef]);

  const selRef = useRef(selection); selRef.current = selection;
  const idsRef = useRef(ids); idsRef.current = ids;

  const pick = useCallback((index: number, e: MouseEvent) => {
    setActive(index);
    if (activation === 'open') { onOpen(index); return; }                                            // touch: a tap opens the photograph
    onSelectionChange(applyClick(selRef.current, idsRef.current, index, { shift: e.shiftKey, toggle: activation === 'toggle' || e.metaKey || e.ctrlKey }));
  }, [onSelectionChange, activation, onOpen]);
  const toggle = useCallback((index: number) => { setActive(index); onSelectionChange(toggleOne(selRef.current, idsRef.current, index)); }, [onSelectionChange]);

  const move = (to: number, extend: boolean) => {
    const n = Math.max(0, Math.min(items.length - 1, to));
    setActive(n);
    virt.scrollToIndex(rowOfIndex(layout.rows, n), { align: 'auto' });
    if (extend) onSelectionChange(applyClick(selection.anchor === null ? { selected: new Set([ids[active]!]), anchor: active } : selection, ids, n, { shift: true }));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!items.length) return;
    const ext = e.shiftKey;
    const perPage = Math.max(1, Math.floor((wrapRef.current?.clientHeight ?? 600) / (rowHeight + gap)));
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); return move(active + 1, ext);
      case 'ArrowLeft': e.preventDefault(); return move(active - 1, ext);
      case 'ArrowDown': e.preventDefault(); return move(verticalNeighbour(layout.rows, active, 1), ext);
      case 'ArrowUp': e.preventDefault(); return move(verticalNeighbour(layout.rows, active, -1), ext);
      case 'PageDown': e.preventDefault(); { let t = active; for (let i = 0; i < perPage; i++) t = verticalNeighbour(layout.rows, t, 1); return move(t, ext); }
      case 'PageUp': e.preventDefault(); { let t = active; for (let i = 0; i < perPage; i++) t = verticalNeighbour(layout.rows, t, -1); return move(t, ext); }
      case 'Home': e.preventDefault(); return move(0, ext);
      case 'End': e.preventDefault(); return move(items.length - 1, ext);
      case ' ': e.preventDefault(); return toggle(active);
      case 'Enter': e.preventDefault(); return onOpen(active);
      case 'Escape': if (selection.selected.size) { e.preventDefault(); onSelectionChange(emptySelection); } return;
      case 'a': case 'A': if (e.metaKey || e.ctrlKey) { e.preventDefault(); onSelectionChange(selectAll(ids)); } return;
      case 'f': case 'F': if (!e.metaKey && !e.ctrlKey) onToggleFavorite?.(active); return;
      case 'p': case 'P': if (!e.metaKey && !e.ctrlKey) onTogglePortfolio?.(active); return;
      default: if (/^[0-5]$/.test(e.key) && !e.metaKey && !e.ctrlKey) onRate?.(active, Number(e.key));
    }
  };

  const activeId = items[active] ? `${idBase}-${items[active]!.id}` : undefined;
  const selectedCount = selection.selected.size;
  return (
    <div ref={wrapRef} style={{ height, overflow: 'auto', position: 'relative' }}>
      <div className="jb-grid" role="listbox" aria-label={label} aria-multiselectable="true" aria-activedescendant={activeId} tabIndex={0}
        data-overlay={overlay} onKeyDown={onKeyDown} style={{ height: layout.totalHeight, width: '100%' }}>
        {virt.getVirtualItems().map((vr) => {
          const row = layout.rows[vr.index];
          if (!row) return null;
          return (
            <div key={vr.index} className="jb-grid__row" style={{ top: row.top, height: row.height, gap }}>
              {row.items.map((it) => {
                const p = items[it.index]!;
                return (
                  <Thumbnail key={p.id} photo={p} index={it.index} domId={`${idBase}-${p.id}`} width={it.width} height={row.height}
                    selected={selection.selected.has(p.id)} active={it.index === active} showScore={showScore}
                    onPick={pick} onOpen={onOpen} onToggle={toggle} />
                );
              })}
            </div>
          );
        })}
      </div>
      {footer && <div className="jb-grid__footer">{footer}</div>}
      <span className="jb-sr-only" role="status" aria-live="polite">{selectedCount ? `${selectedCount} selected` : ''}</span>
    </div>
  );
}
