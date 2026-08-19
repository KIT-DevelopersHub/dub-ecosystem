// Automatic row ordering (並び替え) — a pure, per-user VIEW overlay that re-sequences
// the gantt rows by a chosen key WITHOUT breaking the WBS contiguity invariant that
// GanttView relies on (every parent immediately followed by its own children block,
// for group bands + dependency anchoring). It mirrors `row-order.ts` (manual drag):
// group by parent, stable-sort each sibling group by the mode's key, then
// re-linearize the tree. The manual drag order (`orderedTaskIds`) stays a separate,
// distinct mode — this module never touches it.
//
// Modes:
//  - "priority" 重要度順  : by task.priority (urgent→high→medium→low). Field already
//    exists on task.Task, so this is additive/read-only — no schema change.
//  - "schedule" 時期が早い順: by the row's start date (startsAt, falling back to the
//    due edge endsAt); a parent uses the EARLIEST date in its subtree so work-packages
//    sort by when their work actually begins. Dateless rows sort last.
//  - "team"     チーム順    : by the owning team's position in the member-service team
//    order (the order `useTeams()` returns). Team-less rows sort last.
//  - "manual"               : passthrough — the caller applies the drag overlay instead.
import type { common, gantt, task } from "@dub/types";

type Row = gantt.GanttRow;

export type GanttSortMode = "manual" | "priority" | "schedule" | "team";

export interface SortContext {
  /** taskId → priority (defaults to "medium" when absent). */
  priorityById: ReadonlyMap<common.TaskId, task.TaskPriority>;
  /** taskId → owning team id (null/absent ⇒ team-less, sorts last in team mode). */
  teamIdById: ReadonlyMap<common.TaskId, common.TeamId | null>;
  /** team id → its position in the member-service team order (lower = earlier). */
  teamOrder: ReadonlyMap<common.TeamId, number>;
}

// urgent is the most important → smallest rank so it sorts to the top.
const PRIORITY_RANK: Record<task.TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const DEFAULT_PRIORITY_RANK = PRIORITY_RANK.medium;
const LAST = Number.POSITIVE_INFINITY;

/** Group rows by their effective parent (null = top-level), preserving input order
 *  within each group (that input order is the stable server/WBS default). */
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

/** A row's own date in ms: startsAt, else the due edge (endsAt); dateless ⇒ LAST. */
function rowDateMs(r: Row): number {
  const iso = r.startsAt ?? r.endsAt;
  if (!iso) return LAST;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? LAST : t;
}

/** taskId → the EARLIEST date across the row itself and its whole subtree, so a
 *  work-package (parent) sorts by when its work begins, not its own (often absent)
 *  seed date. Memoized post-order walk; cycle-guarded. */
function effectiveDateMap(
  rows: readonly Row[],
  byId: ReadonlyMap<common.TaskId, Row>,
  groups: ReadonlyMap<common.TaskId | null, Row[]>,
): Map<common.TaskId, number> {
  const memo = new Map<common.TaskId, number>();
  const compute = (id: common.TaskId): number => {
    const seen = memo.get(id);
    if (seen !== undefined) return seen;
    memo.set(id, LAST); // cycle guard
    const self = byId.get(id);
    let best = self ? rowDateMs(self) : LAST;
    for (const child of groups.get(id) ?? []) best = Math.min(best, compute(child.taskId));
    memo.set(id, best);
    return best;
  };
  for (const r of rows) compute(r.taskId);
  return memo;
}

/**
 * Re-order `rows` by an automatic `mode`. Pure + stable + idempotent, and it never
 * drops or re-parents a row. "manual" returns the input unchanged (the caller layers
 * the drag overlay via row-order.applyManualOrder instead).
 */
export function sortRows(rows: readonly Row[], mode: GanttSortMode, ctx: SortContext): Row[] {
  if (rows.length === 0) return [];
  if (mode === "manual") return [...rows];

  const byId = new Map(rows.map((r) => [r.taskId, r] as const));
  const groups = groupByParent(rows);
  const dateMap = mode === "schedule" ? effectiveDateMap(rows, byId, groups) : null;

  const keyOf = (r: Row): number => {
    switch (mode) {
      case "priority":
        return PRIORITY_RANK[ctx.priorityById.get(r.taskId) ?? "medium"] ?? DEFAULT_PRIORITY_RANK;
      case "schedule":
        return dateMap!.get(r.taskId) ?? LAST;
      case "team": {
        const teamId = ctx.teamIdById.get(r.taskId) ?? null;
        if (teamId == null) return LAST;
        return ctx.teamOrder.get(teamId) ?? Number.MAX_SAFE_INTEGER;
      }
      default:
        return 0;
    }
  };

  // Stable sort each sibling group by (key, original index) — ties keep server order.
  for (const [, arr] of groups) {
    const origIndex = new Map(arr.map((r, i) => [r.taskId, i] as const));
    arr.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka !== kb) return ka - kb;
      return origIndex.get(a.taskId)! - origIndex.get(b.taskId)!;
    });
  }

  // Re-linearize: parent, then its (now sorted) children block, recursively.
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
  // Safety net: never drop a row (e.g. a child whose parent is outside the set).
  if (out.length < rows.length) {
    for (const r of rows) if (!emitted.has(r.taskId)) out.push(r);
  }
  return out;
}
