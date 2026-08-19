// WBS hierarchy + dependency-scope rules (判断10 final spec).
//
// A dependency (先行/後続) may only connect two tasks that share the SAME DIRECT
// PARENT — i.e. siblings inside one scope. A parent defines a scope; its children
// form that scope. Consequences:
//   - parent ↔ child dependency: NOT allowed (different scopes)
//   - cross-scope (children under different parents): NOT allowed
//   - sibling ↔ sibling (same direct parent): allowed
//   - parent ↔ parent: allowed (they are siblings in the upper scope)
//   - top-level ↔ top-level: allowed (the null scope is one scope)
// Nesting is unbounded; the rule is always "same direct parent".
import type { common, gantt } from "@dub/types";

export interface ScopeTask {
  id: common.TaskId;
  title: string;
  parentTaskId: common.TaskId | null;
  /** Owning team (null = 未割当). Carried so 親子でチームを一致させる導線が、親のチームを
   *  引ける（子作成時にチームを親に固定・再親付けで親のチームへ追従）。省略時は未割当扱い。 */
  teamId?: common.TeamId | null;
}

/** Project the gantt rows down to the minimal scope info the pickers need. */
export function scopeTasksFromRows(rows: readonly gantt.GanttRow[]): ScopeTask[] {
  return rows.map((r) => ({ id: r.taskId, title: r.title, parentTaskId: r.parentTaskId ?? null, teamId: r.teamId ?? null }));
}

/** Direct parent of a task (null = top-level / not found). */
export function directParentOf(tasks: readonly ScopeTask[], taskId: common.TaskId): common.TaskId | null {
  return tasks.find((t) => t.id === taskId)?.parentTaskId ?? null;
}

/** Owning team of a task (null = 未割当 / not found). Used to fix a child's team to its
 *  parent — 親子でチームが食い違う状態を作らせない（作成時プリフィル・再親付けで追従）。 */
export function teamOf(tasks: readonly ScopeTask[], taskId: common.TaskId): common.TeamId | null {
  return tasks.find((t) => t.id === taskId)?.teamId ?? null;
}

/** Two tasks may share a dependency iff they have the same direct parent. */
export function sameScope(tasks: readonly ScopeTask[], a: common.TaskId, b: common.TaskId): boolean {
  return directParentOf(tasks, a) === directParentOf(tasks, b);
}

/**
 * Candidate predecessors/successors for a task whose direct parent is `parentId`:
 * every other task in the same scope (same direct parent), minus `excludeId`.
 * Used by both the create modal (parent chosen first, then predecessors) and the
 * detail panel (predecessors limited to the task's siblings).
 */
export function dependencyScopeOptions(
  tasks: readonly ScopeTask[],
  parentId: common.TaskId | null,
  excludeId?: common.TaskId | null,
): { id: common.TaskId; title: string }[] {
  return tasks
    .filter((t) => (t.parentTaskId ?? null) === (parentId ?? null) && t.id !== excludeId)
    .map((t) => ({ id: t.id, title: t.title }));
}

/**
 * Candidate WBS parents = the TOP-LEVEL (root) tasks only. Each tree contributes
 * just its root, so deeply-nested descendants are never offered as a parent — you
 * attach a task under a top-level work-package (親は一番上の階層のみ). Excludes
 * `excludeId` (the task being edited) to keep the self/cycle guard.
 */
export function topLevelParentOptions(
  tasks: readonly ScopeTask[],
  excludeId?: common.TaskId | null,
): { id: common.TaskId; title: string }[] {
  return tasks
    .filter((t) => (t.parentTaskId ?? null) === null && t.id !== excludeId)
    .map((t) => ({ id: t.id, title: t.title }));
}

/** Keep only the dependency ids that are in-scope for `parentId` (drop the rest). */
export function pruneToScope(
  tasks: readonly ScopeTask[],
  parentId: common.TaskId | null,
  ids: readonly common.TaskId[],
): common.TaskId[] {
  const allowed = new Set(dependencyScopeOptions(tasks, parentId).map((o) => o.id));
  return ids.filter((id) => allowed.has(id));
}
