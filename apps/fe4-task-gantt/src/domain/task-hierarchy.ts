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
}

/** Project the gantt rows down to the minimal scope info the pickers need. */
export function scopeTasksFromRows(rows: readonly gantt.GanttRow[]): ScopeTask[] {
  return rows.map((r) => ({ id: r.taskId, title: r.title, parentTaskId: r.parentTaskId ?? null }));
}

/** Direct parent of a task (null = top-level / not found). */
export function directParentOf(tasks: readonly ScopeTask[], taskId: common.TaskId): common.TaskId | null {
  return tasks.find((t) => t.id === taskId)?.parentTaskId ?? null;
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

/** Keep only the dependency ids that are in-scope for `parentId` (drop the rest). */
export function pruneToScope(
  tasks: readonly ScopeTask[],
  parentId: common.TaskId | null,
  ids: readonly common.TaskId[],
): common.TaskId[] {
  const allowed = new Set(dependencyScopeOptions(tasks, parentId).map((o) => o.id));
  return ids.filter((id) => allowed.has(id));
}
