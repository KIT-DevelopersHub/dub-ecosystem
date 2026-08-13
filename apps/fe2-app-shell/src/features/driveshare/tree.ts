// Pure tree logic for the Drive sharing manager's lazy hierarchy view.
//
// The tree never holds the whole hierarchy in memory: each folder's children are
// fetched on demand (listFiles({folderId})) and cached by react-query. This module
// owns only the *view* state that has no server round-trip — which folders are open,
// the query key a folder's children live under, and the keyboard-navigation index
// math — so all of it stays trivially unit-testable without React or the network.
import { queryKeys } from "../../lib/queryKeys.tsx";

/** Toggle a folder id in the expanded set, returning a NEW set (immutability keeps
 *  React state updates predictable). Opening is optimistic — the caller flips this
 *  immediately and the child fetch resolves underneath a skeleton. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** react-query key for a folder's direct children. Distinct from the root files key
 *  (…,"files", search) so opening a folder never clobbers the root list cache. */
export function childrenQueryKey(folderId: string): readonly unknown[] {
  return queryKeys.feature("driveshare", "files", "children", folderId);
}

/** aria-level is 1-based; the root row is level 1 (depth 0). */
export function ariaLevel(depth: number): number {
  return depth + 1;
}

/** Clamp roving-focus movement to the visible-node list bounds (no wrap): Arrow
 *  Down past the last node and Arrow Up past the first are both no-ops. Returns the
 *  next index to focus. `count` is the number of currently-visible tree items. */
export function nextFocusIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  const target = current + dir;
  if (target < 0) return 0;
  if (target > count - 1) return count - 1;
  return target;
}
