// WBS hierarchy + dependency-scope rules.
//
// UPDATED SPEC (cross-scope deps / ADR-0007 — supersedes 判断10):
// A dependency (先行/後続) may connect two tasks across DIFFERENT hierarchy levels
// (別スコープ/別階層) as long as they belong to the SAME TEAM. The old rule ("same
// direct parent only") is lifted. The single hard boundary is now the TEAM:
//   - same team, any scope (sibling / parent↔child / cross-scope): allowed
//   - different team: NOT allowed (cross-team work goes through the 送る・受け取る
//     request/approval flow instead — it never draws a dependency arrow)
//   - `teamId === null` is its own "no team" bucket: two team-less tasks may depend
//     (back-compat); a one-sided null is a team mismatch (rejected).
// This mirrors the backend门番 in services/task-service (`cross_team_not_allowed`) so
// the picker never offers an edge the server would reject. `directParentOf` is retained
// for WBS parent context (not for the dependency gate).
import type { common, gantt } from "@dub/types";

export interface ScopeTask {
  id: common.TaskId;
  title: string;
  parentTaskId: common.TaskId | null;
  /** Owning team — the dependency boundary (same team ⇒ same scope for deps). null=未割当。
   *  Optional so 親子でチームを親に固定する導線（子作成/再親付け）が teamId 省略でも通る。 */
  teamId?: common.TeamId | null;
}

/** Project the gantt rows down to the minimal scope info the pickers need. */
export function scopeTasksFromRows(rows: readonly gantt.GanttRow[]): ScopeTask[] {
  return rows.map((r) => ({
    id: r.taskId,
    title: r.title,
    parentTaskId: r.parentTaskId ?? null,
    teamId: r.teamId ?? null,
  }));
}

/** Direct parent of a task (null = top-level / not found). Used for WBS parent context. */
export function directParentOf(tasks: readonly ScopeTask[], taskId: common.TaskId): common.TaskId | null {
  return tasks.find((t) => t.id === taskId)?.parentTaskId ?? null;
}

/** Owning team of a task (null = 未割当 / not found). Used to fix a child's team to its
 *  parent — 親子でチームが食い違う状態を作らせない（作成時プリフィル・再親付けで追従）。 */
export function teamOf(tasks: readonly ScopeTask[], taskId: common.TaskId): common.TeamId | null {
  return tasks.find((t) => t.id === taskId)?.teamId ?? null;
}

/**
 * Same-team test — the dependency boundary. `null === null` is one shared "no team"
 * bucket (back-compat); a one-sided null is a mismatch. Mirrors the backend门番.
 */
export function sameTeam(a: common.TeamId | null, b: common.TeamId | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** Two tasks may share a dependency iff they belong to the same team. */
export function sameScope(tasks: readonly ScopeTask[], a: common.TaskId, b: common.TaskId): boolean {
  return sameTeam(teamOf(tasks, a), teamOf(tasks, b));
}

/**
 * Candidate predecessors/successors for a task on team `teamId`: every other task on
 * the SAME team (any scope / hierarchy level), minus `excludeId`. Cross-team tasks are
 * excluded (they go through the request/approval flow, never a dependency arrow). Used
 * by both the create modal (team chosen first, then predecessors) and the detail panel.
 */
export function dependencyScopeOptions(
  tasks: readonly ScopeTask[],
  teamId: common.TeamId | null,
  excludeId?: common.TaskId | null,
): { id: common.TaskId; title: string }[] {
  return tasks
    .filter((t) => sameTeam(t.teamId ?? null, teamId ?? null) && t.id !== excludeId)
    .map((t) => ({ id: t.id, title: t.title }));
}

/** Keep only the dependency ids that are same-team for `teamId` (drop cross-team ones). */
export function pruneToScope(
  tasks: readonly ScopeTask[],
  teamId: common.TeamId | null,
  ids: readonly common.TaskId[],
): common.TaskId[] {
  const allowed = new Set(dependencyScopeOptions(tasks, teamId).map((o) => o.id));
  return ids.filter((id) => allowed.has(id));
}
