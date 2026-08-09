// DnD reorder using the gap method (1024 stride) — FE3 recommendation in the
// design's open-item #1 (single PATCH per move, server normalizes on exhaustion;
// no bulk API in P0). All pure so it is unit-tested without the DOM.

export const SORT_GAP = 1024;

export interface Ordered {
  id: string;
  sortOrder: number;
}

/** Next sortOrder to append after the current last item. */
export function nextSortOrder(items: readonly Ordered[]): number {
  if (items.length === 0) return SORT_GAP;
  const max = Math.max(...items.map((i) => i.sortOrder));
  return max + SORT_GAP;
}

/** Midpoint between two neighbour orders; null when the gap is exhausted. */
export function midpoint(prev: number | null, next: number | null): number | null {
  if (prev === null && next === null) return SORT_GAP;
  if (prev === null) return (next as number) - SORT_GAP;
  if (next === null) return prev + SORT_GAP;
  if (next - prev <= 1) return null; // exhausted -> caller requests server normalization
  return Math.floor((prev + next) / 2);
}

export interface ReorderResult {
  id: string;
  sortOrder: number;
  /** true when the gap is exhausted and the server must re-normalize sortOrders. */
  needsNormalization: boolean;
}

/**
 * Compute the new sortOrder for moving `activeId` to the slot currently held by
 * `overId`, given the list in its current visual order. Returns null if the move
 * is a no-op or ids are unknown.
 */
export function computeReorder(
  items: readonly Ordered[],
  activeId: string,
  overId: string,
): ReorderResult | null {
  if (activeId === overId) return null;
  const from = items.findIndex((i) => i.id === activeId);
  const to = items.findIndex((i) => i.id === overId);
  if (from === -1 || to === -1) return null;

  // The list without the active item, then the target index in that list.
  const without = items.filter((i) => i.id !== activeId);
  const overIdxInWithout = without.findIndex((i) => i.id === overId);
  // Moving down (from < to): land after `over`; moving up: land before `over`.
  const insertAt = from < to ? overIdxInWithout + 1 : overIdxInWithout;

  const prev = insertAt > 0 ? without[insertAt - 1]!.sortOrder : null;
  const next = insertAt < without.length ? without[insertAt]!.sortOrder : null;
  const mid = midpoint(prev, next);
  if (mid === null) {
    return { id: activeId, sortOrder: NaN, needsNormalization: true };
  }
  return { id: activeId, sortOrder: mid, needsNormalization: false };
}
