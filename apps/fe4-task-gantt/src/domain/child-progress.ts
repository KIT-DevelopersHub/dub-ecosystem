// Parent (work-package) roll-up of its children's STATUS mix, so a parent bar can
// show — at a glance — how far its subtree has progressed ("子: 3/5 完了"). This is
// the status analogue of `rollupRowDates` (which rolls up the children's DATES): it
// stays a pure, unit-tested function over the gantt rows + the status map the view
// already holds, so the component only renders the result.
//
// Scope note: counts DIRECT children of each parent (matches the "n/m 完了" reading —
// each child is one unit, coloured by its own status). Children that are themselves
// parents count as one unit by their own stored status; no double-counting of leaves.
import type { common, gantt, task } from "@dub/types";

/** One coloured slice of a parent bar: a status and the share of children in it. */
export interface ProgressSegment {
  status: task.TaskStatus;
  count: number;
  /** 0..1 share of the parent's direct children in this status. */
  fraction: number;
}

export interface ChildProgress {
  /** Number of direct children (the "m" in "n/m 完了"). Always > 0 here. */
  total: number;
  doneCount: number;
  inProgressCount: number;
  todoCount: number;
  blockedCount: number;
  cancelledCount: number;
  /** round(doneCount / total * 100). */
  donePercent: number;
  /** Non-empty slices in stacked draw order (done → in_progress → blocked → todo →
   *  cancelled), left-to-right. Fractions sum to 1. */
  segments: ProgressSegment[];
}

// Stacked order: completed first (left), then active, then not-yet / stalled. This
// gives the bar a natural "fills up green from the left as work completes" reading.
const STACK_ORDER: readonly task.TaskStatus[] = ["done", "in_progress", "blocked", "todo", "cancelled"];

/**
 * Map every WBS parent (a row that at least one other row names as its
 * `parentTaskId`) to the status mix of its DIRECT children. Rows with no children
 * are absent from the result. Pure; O(rows).
 */
export function childProgressByParent(
  rows: readonly gantt.GanttRow[],
  statusById: ReadonlyMap<common.TaskId, task.TaskStatus>,
): Map<common.TaskId, ChildProgress> {
  // parentId -> counts keyed by status
  const counts = new Map<common.TaskId, Map<task.TaskStatus, number>>();
  for (const r of rows) {
    const parentId = r.parentTaskId;
    if (!parentId) continue;
    const status = statusById.get(r.taskId) ?? "todo";
    let byStatus = counts.get(parentId);
    if (!byStatus) {
      byStatus = new Map();
      counts.set(parentId, byStatus);
    }
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  const out = new Map<common.TaskId, ChildProgress>();
  for (const [parentId, byStatus] of counts) {
    let total = 0;
    for (const n of byStatus.values()) total += n;
    if (total === 0) continue;
    const get = (s: task.TaskStatus) => byStatus.get(s) ?? 0;
    const doneCount = get("done");
    const segments: ProgressSegment[] = [];
    for (const status of STACK_ORDER) {
      const count = get(status);
      if (count > 0) segments.push({ status, count, fraction: count / total });
    }
    out.set(parentId, {
      total,
      doneCount,
      inProgressCount: get("in_progress"),
      todoCount: get("todo"),
      blockedCount: get("blocked"),
      cancelledCount: get("cancelled"),
      donePercent: Math.round((doneCount / total) * 100),
      segments,
    });
  }
  return out;
}
