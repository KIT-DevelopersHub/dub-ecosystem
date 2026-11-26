// Who may EDIT one task (#881). Single source for task-service (the real gate) and FE4
// (read-only rendering), re-exported through the `task` namespace.
//
// Rule: a holder of `task:edit_all` edits every task. Anyone else (who already passed the
// route's `task:write` / calendar gate) edits only a task they are an assignee of — the
// person assignee, or a member of the task's team (see isTaskAssignee) — or one they created
// themselves. A parent task does NOT become editable because a child is assigned to me — the
// child row is editable on its own, the parent's fields stay with its assignee.
import type { TeamId, UserId } from "./common";

export const TASK_EDIT_ALL_KEY = "task:edit_all" as const;

/** The task fields the rule reads. */
export interface TaskEditSubject {
  assigneeId: UserId | null;
  /** 担当チーム (#882). Optional so the rule works before/without that column. */
  assigneeTeamId?: TeamId | null;
  /** 所属チーム (the gantt「チーム」). */
  teamId?: TeamId | null;
  createdBy?: UserId;
}

/**
 * The acting user. `teamIds` = the teams they belong to: `myTeamIds` of member-service
 * `GET /members/me/mention-teams` (名簿 team links) — task-service and FE4 both read it.
 * Omitted ⇒ no team grants.
 */
export interface TaskEditor {
  userId: UserId;
  teamIds?: readonly TeamId[];
}

/** The teams whose members count as assignees of `t` (担当チーム and 所属チーム). */
export function taskTeamIds(t: TaskEditSubject): TeamId[] {
  const out: TeamId[] = [];
  if (t.assigneeTeamId) out.push(t.assigneeTeamId);
  if (t.teamId && t.teamId !== t.assigneeTeamId) out.push(t.teamId);
  return out;
}

/**
 * Is `editor` an assignee of `t`? THE place that decides it: the person assignee, or a member
 * of a team the task is handed to (`assigneeTeamId`) or belongs to (`teamId`) — tasks are
 * usually given to a team, so its members edit them.
 */
export function isTaskAssignee(t: TaskEditSubject, editor: TaskEditor): boolean {
  if (t.assigneeId !== null && t.assigneeId === editor.userId) return true;
  const mine = editor.teamIds;
  if (!mine || mine.length === 0) return false;
  return taskTeamIds(t).some((id) => mine.includes(id));
}

/** Instance-level edit check (the `task:write` key check happens before this). */
export function canEditTask(t: TaskEditSubject, editor: TaskEditor, holdsEditAll: boolean): boolean {
  if (holdsEditAll) return true;
  if (isTaskAssignee(t, editor)) return true;
  return t.createdBy !== undefined && t.createdBy === editor.userId;
}
