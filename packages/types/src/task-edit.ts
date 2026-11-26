// Who may EDIT one task (#881). Single source for task-service (the real gate) and FE4
// (read-only rendering), re-exported through the `task` namespace.
//
// Rule: a holder of `task:edit_all` edits every task. Anyone else (who already passed the
// route's `task:write` / calendar gate) edits only a task they are assigned to, or one they
// created themselves. A parent task does NOT become editable because a child is assigned to
// me — the child row is editable on its own, the parent's fields stay with its assignee.
import type { TeamId, UserId } from "./common";

export const TASK_EDIT_ALL_KEY = "task:edit_all" as const;

/** The task fields the rule reads. #882 (team assignees) adds its field here. */
export interface TaskEditSubject {
  assigneeId: UserId | null;
  createdBy?: UserId;
}

/** The acting user. `teamIds` is for #882 ("assigned to my team"); unused until then. */
export interface TaskEditor {
  userId: UserId;
  teamIds?: readonly TeamId[];
}

/** Is `editor` an assignee of `t`? THE place to extend when a task can be assigned to a team. */
export function isTaskAssignee(t: TaskEditSubject, editor: TaskEditor): boolean {
  return t.assigneeId !== null && t.assigneeId === editor.userId;
}

/** Instance-level edit check (the `task:write` key check happens before this). */
export function canEditTask(t: TaskEditSubject, editor: TaskEditor, holdsEditAll: boolean): boolean {
  if (holdsEditAll) return true;
  if (isTaskAssignee(t, editor)) return true;
  return t.createdBy !== undefined && t.createdBy === editor.userId;
}
