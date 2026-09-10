// Parent (work-package) roll-up of its subtree's leaf STATUS mix, so a parent bar can
// show — at a glance — how far its subtree has progressed ("子: 3/5 完了") and the
// gantt/detail UI can display ONE representative status for a task whose own `status`
// column is not the source of truth once it has children (旧バグ: 子を変えても親の
// ドロップダウン表示が変わらない/2階層までしか集計されない — 判断: 親・子・孫…何階層でも
// 再帰的に最下層(葉)から集計する)。This is the status analogue of `rollupRowDates`
// (which rolls up the children's DATES): it stays a pure, unit-tested function over the
// gantt rows + the status map the view already holds, so the component only renders
// the result.
//
// Scope: recursively aggregates over every LEAF descendant (a row with no children of
// its own) under a node — not just its direct children. An intermediate node (a parent
// that is itself also someone's child) is never counted by its OWN stored status column;
// its contribution is entirely the recursive aggregate of ITS descendants' leaves. This
// makes the roll-up correct at any depth: leaf → parent → grandparent → … → root, each
// level re-deriving from the level below it (memoised so each row is visited once).
import type { common, gantt, task } from "@dub/types";

/** One coloured slice of a parent bar: a status and the share of leaf descendants in it. */
export interface ProgressSegment {
  status: task.TaskStatus;
  count: number;
  /** 0..1 share of the parent's leaf descendants in this status. */
  fraction: number;
}

export interface ChildProgress {
  /** Number of leaf descendants (the "m" in "n/m 完了"). Always > 0 here. */
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
  /** The PLURALITY status among leaf descendants — the single value to show wherever
   *  only one status can be displayed (ドロップダウン表示・行の丸ドット等). Ties break
   *  toward the "least complete" reading (see TIE_BREAK_ORDER) so a 50/50 mix never
   *  quietly reads as 完了. */
  dominantStatus: task.TaskStatus;
}

// Stacked order: completed first (left), then active, then not-yet / stalled. This
// gives the bar a natural "fills up green from the left as work completes" reading.
const STACK_ORDER: readonly task.TaskStatus[] = ["done", "in_progress", "blocked", "todo", "cancelled"];

// Tie-break order for `dominantStatus`: when two+ statuses share the top count, prefer
// whichever comes FIRST here. Ordered from "needs the most attention / least complete"
// to "most complete", so a tie never silently paints a still-blocked/still-active
// subtree as 完了 (or hides a blocked slice behind a bigger-looking todo tie, etc).
const TIE_BREAK_ORDER: readonly task.TaskStatus[] = ["blocked", "in_progress", "todo", "cancelled", "done"];

function dominantStatusOf(byStatus: ReadonlyMap<task.TaskStatus, number>): task.TaskStatus {
  let best: task.TaskStatus = "todo";
  let bestCount = -1;
  for (const status of TIE_BREAK_ORDER) {
    const n = byStatus.get(status) ?? 0;
    if (n > bestCount) {
      bestCount = n;
      best = status;
    }
  }
  return best;
}

/**
 * Map every WBS parent (a row that at least one other row names as its
 * `parentTaskId`, at ANY depth) to the status mix of its leaf descendants, aggregated
 * RECURSIVELY: a leaf contributes its own status; an intermediate parent contributes
 * the (already-aggregated) mix of ITS children, never its own stored status column.
 * Rows with no children are absent from the result. Pure; O(rows) via post-order
 * memoisation (each row's leaf-mix is computed once regardless of how many ancestors
 * read it or how deep the tree is).
 */
export function childProgressByParent(
  rows: readonly gantt.GanttRow[],
  statusById: ReadonlyMap<common.TaskId, task.TaskStatus>,
): Map<common.TaskId, ChildProgress> {
  const childrenOf = new Map<common.TaskId, common.TaskId[]>();
  for (const r of rows) {
    if (!r.parentTaskId) continue;
    let kids = childrenOf.get(r.parentTaskId);
    if (!kids) {
      kids = [];
      childrenOf.set(r.parentTaskId, kids);
    }
    kids.push(r.taskId);
  }

  // taskId -> leaf-status counts for its OWN subtree (a leaf's map is {itsStatus: 1}).
  // `visiting` guards a malformed cyclic parent chain from hanging the aggregation.
  const memo = new Map<common.TaskId, Map<task.TaskStatus, number>>();
  const visiting = new Set<common.TaskId>();

  const leafCountsOf = (id: common.TaskId): Map<task.TaskStatus, number> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const kids = childrenOf.get(id);
    if (!kids || kids.length === 0) {
      const status = statusById.get(id) ?? "todo";
      const own = new Map<task.TaskStatus, number>([[status, 1]]);
      memo.set(id, own);
      return own;
    }
    if (visiting.has(id)) {
      // Cyclic parentage (should never happen) — fall back to this node's own status
      // rather than recursing forever.
      const status = statusById.get(id) ?? "todo";
      return new Map([[status, 1]]);
    }
    visiting.add(id);
    const merged = new Map<task.TaskStatus, number>();
    for (const kid of kids) {
      for (const [status, n] of leafCountsOf(kid)) {
        merged.set(status, (merged.get(status) ?? 0) + n);
      }
    }
    visiting.delete(id);
    memo.set(id, merged);
    return merged;
  };

  const out = new Map<common.TaskId, ChildProgress>();
  for (const parentId of childrenOf.keys()) {
    const byStatus = leafCountsOf(parentId);
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
      dominantStatus: dominantStatusOf(byStatus),
    });
  }
  return out;
}
