/** Photo selection model: click = single, ⌘/Ctrl-click = toggle, Shift-click = range from the anchor, Space = toggle. Pure. */
export interface SelectionState { selected: ReadonlySet<string>; anchor: number | null }
export const emptySelection: SelectionState = { selected: new Set(), anchor: null };

export function applyClick(
  state: SelectionState,
  ids: readonly string[],
  index: number,
  mods: { shift?: boolean; toggle?: boolean },
): SelectionState {
  const id = ids[index];
  if (id === undefined) return state;
  if (mods.shift && state.anchor !== null) {
    const [a, b] = state.anchor < index ? [state.anchor, index] : [index, state.anchor];
    const next = mods.toggle ? new Set(state.selected) : new Set<string>();
    for (let i = a; i <= b; i++) next.add(ids[i]!);
    return { selected: next, anchor: state.anchor };
  }
  if (mods.toggle) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { selected: next, anchor: index };
  }
  return { selected: new Set([id]), anchor: index };
}

export function toggleOne(state: SelectionState, ids: readonly string[], index: number): SelectionState {
  return applyClick(state, ids, index, { toggle: true });
}

export function selectAll(ids: readonly string[]): SelectionState {
  return { selected: new Set(ids), anchor: ids.length ? 0 : null };
}
