// Manual row ordering (drag-and-drop reorder). The gantt-service ships rows in a
// WBS/title order with every parent immediately followed by its own children block
// (GanttView relies on that contiguity for group bands + dependency anchoring). A
// user's personal drag order is a per-user overlay persisted in the gantt view
// state (`orderedTaskIds`); this module applies it WITHOUT breaking the contiguity
// invariant — it only re-sorts siblings within their own parent group, then
// re-linearizes the tree (parent, then its sorted children, recursively).
import type { common, gantt } from "@dub/types";

type Row = gantt.GanttRow;

/** Group rows by their effective parent (null = top-level), preserving the input
 *  order within each group (that input order is the server default / stable base). */
function groupByParent(rows: readonly Row[]): Map<common.TaskId | null, Row[]> {
  const groups = new Map<common.TaskId | null, Row[]>();
  for (const r of rows) {
    const p = r.parentTaskId ?? null;
    const arr = groups.get(p);
    if (arr) arr.push(r);
    else groups.set(p, [r]);
  }
  return groups;
}

/**
 * Re-order `rows` by a manual `orderedTaskIds` overlay. Ids listed in the overlay
 * are pinned to that relative position within their sibling group; ids NOT listed
 * keep their original relative order and sort after the listed ones. The tree is
 * then re-linearized so each parent is still immediately followed by its (now
 * re-sorted) children block. Pure + stable + idempotent.
 */
export function applyManualOrder(rows: readonly Row[], orderedTaskIds: readonly common.TaskId[]): Row[] {
  if (rows.length === 0) return [];
  if (orderedTaskIds.length === 0) return [...rows];

  const rank = new Map<common.TaskId, number>();
  orderedTaskIds.forEach((id, i) => rank.set(id, i));
  const BIG = orderedTaskIds.length; // unlisted ids sort after every listed one

  const groups = groupByParent(rows);
  // Stable sort each sibling group by (manual rank, original index).
  for (const [, arr] of groups) {
    const origIndex = new Map(arr.map((r, i) => [r.taskId, i] as const));
    arr.sort((a, b) => {
      const ra = rank.get(a.taskId) ?? BIG + origIndex.get(a.taskId)!;
      const rb = rank.get(b.taskId) ?? BIG + origIndex.get(b.taskId)!;
      return ra - rb;
    });
  }

  const out: Row[] = [];
  const emitted = new Set<common.TaskId>();
  const walk = (parent: common.TaskId | null): void => {
    for (const r of groups.get(parent) ?? []) {
      if (emitted.has(r.taskId)) continue; // cycle-guard
      emitted.add(r.taskId);
      out.push(r);
      walk(r.taskId);
    }
  };
  walk(null);
  // Safety net: never drop a row (e.g. a parent pointing outside the set).
  if (out.length < rows.length) {
    for (const r of rows) if (!emitted.has(r.taskId)) out.push(r);
  }
  return out;
}

/**
 * Move a MULTI-SELECTION up (dir=-1) or down (dir=+1) by one slot, per sibling
 * group, and return the full `orderedTaskIds` to persist (or null when nothing
 * moves — e.g. the whole selection is already at the group's edge).
 *
 * Each parent group is reordered independently: the selected members slide as a
 * block past one unselected neighbour, keeping their own relative order and the
 * WBS parent→children contiguity (the tree is re-linearised at the end). This is
 * the vertical counterpart to a marquee bulk move; only 手動 mode uses it (an
 * automatic sort would just overwrite the result next render).
 */
export function moveSelectionVertical(
  rows: readonly Row[],
  selectedIds: ReadonlySet<common.TaskId>,
  dir: -1 | 1,
): common.TaskId[] | null {
  if (rows.length === 0 || selectedIds.size === 0) return null;
  const groups = groupByParent(rows);
  const reordered = new Map<common.TaskId | null, common.TaskId[]>();
  let changed = false;
  for (const [parent, arr] of groups) {
    const ids = arr.map((r) => r.taskId);
    const moved = moveBlockWithinGroup(ids, selectedIds, dir);
    if (moved.changed) changed = true;
    reordered.set(parent, moved.ids);
  }
  if (!changed) return null;

  const out: common.TaskId[] = [];
  const emitted = new Set<common.TaskId>();
  const walk = (parent: common.TaskId | null): void => {
    for (const id of reordered.get(parent) ?? []) {
      if (emitted.has(id)) continue;
      emitted.add(id);
      out.push(id);
      walk(id);
    }
  };
  walk(null);
  if (out.length < rows.length) {
    for (const r of rows) if (!emitted.has(r.taskId)) out.push(r.taskId);
  }
  return out;
}

/** Slide the selected members of one ordered group by one slot in `dir`, as a
 *  block (each selected item hops one unselected neighbour). Pure; returns the new
 *  order and whether it changed. */
function moveBlockWithinGroup(
  ids: readonly common.TaskId[],
  selected: ReadonlySet<common.TaskId>,
  dir: -1 | 1,
): { ids: common.TaskId[]; changed: boolean } {
  const a = [...ids];
  let changed = false;
  if (dir === -1) {
    for (let i = 1; i < a.length; i++) {
      if (selected.has(a[i]!) && !selected.has(a[i - 1]!)) {
        [a[i - 1], a[i]] = [a[i]!, a[i - 1]!];
        changed = true;
      }
    }
  } else {
    for (let i = a.length - 2; i >= 0; i--) {
      if (selected.has(a[i]!) && !selected.has(a[i + 1]!)) {
        [a[i + 1], a[i]] = [a[i]!, a[i + 1]!];
        changed = true;
      }
    }
  }
  return { ids: a, changed };
}

/**
 * The "roots" of a selection: selected ids that have NO selected ancestor. Shifting
 * a work-package (parent) already carries its whole subtree, so a bulk horizontal
 * move must skip any selected descendant of another selected id — otherwise a child
 * both inside a shifted subtree AND individually shifted would move twice.
 */
export function selectionRoots(
  rows: readonly Row[],
  selectedIds: ReadonlySet<common.TaskId>,
): common.TaskId[] {
  const parentOf = new Map<common.TaskId, common.TaskId | null>(
    rows.map((r) => [r.taskId, r.parentTaskId ?? null] as const),
  );
  const hasSelectedAncestor = (id: common.TaskId): boolean => {
    let p = parentOf.get(id) ?? null;
    const guard = new Set<common.TaskId>();
    while (p && !guard.has(p)) {
      guard.add(p);
      if (selectedIds.has(p)) return true;
      p = parentOf.get(p) ?? null;
    }
    return false;
  };
  const out: common.TaskId[] = [];
  for (const r of rows) {
    if (selectedIds.has(r.taskId) && !hasSelectedAncestor(r.taskId)) out.push(r.taskId);
  }
  return out;
}

/** arrayMove — pure list move (a selected member hops to another slot). */
function moveInList<T>(arr: readonly T[], from: number, to: number): T[] {
  const copy = arr.slice();
  const [moved] = copy.splice(from, 1);
  if (moved !== undefined) copy.splice(to, 0, moved);
  return copy;
}

/**
 * Group drag-reorder (⑤ グループD&D): drag ONE row of a marquee multi-selection and the
 * whole selected block moves together to the drop position, staying contiguous and keeping
 * its internal order. `draggedId` is the grabbed row, `overId` the row it was dropped onto
 * (SortableList's active/over). Only the dragged row's own sibling group participates:
 * selected members in OTHER groups are left where they are, and a cross-group drop is a
 * no-op (re-parenting stays an explicit detail-panel action) — same discipline as the
 * single-row `reorderWithinSiblings`. Returns the full `orderedTaskIds` to persist, or null
 * on a no-op. Pure + stable.
 */
export function reorderSelectionWithinSiblings(
  rows: readonly Row[],
  selectedIds: ReadonlySet<common.TaskId>,
  draggedId: common.TaskId,
  overId: common.TaskId,
): common.TaskId[] | null {
  const byId = new Map(rows.map((r) => [r.taskId, r] as const));
  const dragged = byId.get(draggedId);
  const over = byId.get(overId);
  if (!dragged || !over) return null;
  const parent = dragged.parentTaskId ?? null;
  // Same-parent only: a cross-group drop is rejected (mirrors single-row reorder).
  if ((over.parentTaskId ?? null) !== parent) return null;

  const sibs = rows.filter((r) => (r.parentTaskId ?? null) === parent).map((r) => r.taskId);
  // The block that travels together: selected siblings, always including the grabbed row,
  // in their current sibling order (so the 3 rows stay in their relative sequence).
  const movingSet = new Set(sibs.filter((id) => selectedIds.has(id)));
  movingSet.add(draggedId);
  const movingOrder = sibs.filter((id) => movingSet.has(id));

  const from = sibs.indexOf(draggedId);
  const to = sibs.indexOf(overId);
  if (from < 0 || to < 0) return null;
  // Land the grabbed row first (this gets the drop DIRECTION right), then collapse the other
  // moving members out and re-insert the whole block contiguously at the grabbed row's slot.
  const moved = moveInList(sibs, from, to);
  const compact = moved.filter((id) => id === draggedId || !movingSet.has(id));
  const at = compact.indexOf(draggedId);
  if (at < 0) return null;
  compact.splice(at, 1, ...movingOrder);

  // Merge the new sibling order back into the full linear order (substitute this group's
  // slots with `compact`), keeping every other row's position — same as reorderWithinSiblings.
  const groupQueue = [...compact];
  const full: common.TaskId[] = [];
  for (const r of rows) {
    if ((r.parentTaskId ?? null) === parent) {
      const next = groupQueue.shift();
      if (next) full.push(next);
    } else {
      full.push(r.taskId);
    }
  }
  return full;
}

/**
 * Given the CURRENT linear rows and a sibling reorder (a task moved to sit right
 * before `beforeTaskId`, or to the end of its group when null), produce the full
 * `orderedTaskIds` sequence to persist. Only same-parent moves are honoured — a
 * cross-parent drop returns null (caller ignores it; re-parenting is a separate,
 * explicit action in the detail panel).
 */
export function reorderWithinSiblings(
  rows: readonly Row[],
  draggedId: common.TaskId,
  beforeTaskId: common.TaskId | null,
): common.TaskId[] | null {
  const byId = new Map(rows.map((r) => [r.taskId, r] as const));
  const dragged = byId.get(draggedId);
  if (!dragged) return null;
  const parent = dragged.parentTaskId ?? null;
  // Target must be a sibling (same parent) — or null to append at the group end.
  if (beforeTaskId !== null) {
    const target = byId.get(beforeTaskId);
    if (!target || (target.parentTaskId ?? null) !== parent) return null;
    if (beforeTaskId === draggedId) return null;
  }

  const siblings = rows.filter((r) => (r.parentTaskId ?? null) === parent).map((r) => r.taskId);
  const without = siblings.filter((id) => id !== draggedId);
  const at = beforeTaskId === null ? without.length : without.indexOf(beforeTaskId);
  if (at < 0) return null;
  without.splice(at, 0, draggedId);

  // Merge the new sibling order into a full-order list: emit every row's id in the
  // current linear order, but substitute this group's ids with `without`. This keeps
  // a complete, stable overlay (so applyManualOrder is a pure sort by index).
  const groupQueue = [...without];
  const full: common.TaskId[] = [];
  for (const r of rows) {
    if ((r.parentTaskId ?? null) === parent) {
      const next = groupQueue.shift();
      if (next) full.push(next);
    } else {
      full.push(r.taskId);
    }
  }
  return full;
}
