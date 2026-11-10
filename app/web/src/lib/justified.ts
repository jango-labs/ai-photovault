/**
 * Justified-row layout (contact-sheet style): every row is scaled so its photographs exactly fill the width,
 * aspect ratios are preserved (no cropping, no distortion). Pure and O(n) so it stays instant at 100,000 photos.
 */
export interface JustifiedItem { index: number; x: number; width: number }
export interface JustifiedRow { top: number; height: number; items: JustifiedItem[]; last: boolean }
export interface JustifiedLayout { rows: JustifiedRow[]; totalHeight: number }

export function justifiedLayout(
  aspects: ArrayLike<number>,
  containerWidth: number,
  targetRowHeight: number,
  gap: number,
  opts: { maxRowHeight?: number } = {},
): JustifiedLayout {
  const n = aspects.length;
  const maxH = opts.maxRowHeight ?? targetRowHeight * 1.6;
  const rows: JustifiedRow[] = [];
  if (n === 0 || containerWidth <= 0) return { rows, totalHeight: 0 };
  let top = 0;
  let start = 0;
  while (start < n) {
    let sum = 0;
    let end = start;
    // add photographs until the row at target height would be at least as wide as the container
    while (end < n) {
      sum += Math.max(0.1, aspects[end]!);
      end++;
      const widthAtTarget = sum * targetRowHeight + gap * (end - start - 1);
      if (widthAtTarget >= containerWidth) break;
    }
    const count = end - start;
    const widthAtTarget = sum * targetRowHeight + gap * (count - 1);
    const isLast = end >= n;
    // the final partial row keeps the target height (never blown up); full rows are scaled to fit exactly
    let height = isLast && widthAtTarget < containerWidth ? targetRowHeight : (containerWidth - gap * (count - 1)) / sum;
    height = Math.min(height, maxH);
    const items: JustifiedItem[] = [];
    let x = 0;
    for (let i = start; i < end; i++) {
      const w = Math.max(0.1, aspects[i]!) * height;
      items.push({ index: i, x, width: w });
      x += w + gap;
    }
    rows.push({ top, height, items, last: isLast });
    top += height + gap;
    start = end;
  }
  return { rows, totalHeight: Math.max(0, top - gap) };
}

/** Which row contains photograph `index`? (binary search over row start indices) */
export function rowOfIndex(rows: JustifiedRow[], index: number): number {
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid]!.items[0]!.index <= index) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Keyboard navigation target for Up/Down: the photograph in the neighbouring row nearest to the current horizontal centre. */
export function verticalNeighbour(rows: JustifiedRow[], index: number, dir: -1 | 1): number {
  const r = rowOfIndex(rows, index);
  const nr = r + dir;
  if (nr < 0 || nr >= rows.length) return index;
  const cur = rows[r]!.items.find((it) => it.index === index)!;
  const cx = cur.x + cur.width / 2;
  let best = rows[nr]!.items[0]!;
  let bestD = Infinity;
  for (const it of rows[nr]!.items) {
    const d = Math.abs(it.x + it.width / 2 - cx);
    if (d < bestD) { best = it; bestD = d; }
  }
  return best.index;
}
