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
