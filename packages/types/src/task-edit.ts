// Who may EDIT one task (#881). Single source for task-service (the real gate) and FE4
// (read-only rendering), re-exported through the `task` namespace.
//
// Rule (owner decision):
//   - a holder of `task:edit_all` (admin / maintainer) edits every task;
//   - 依頼者 (`requesterId`) が設定されていれば、その人も編集できる;
//   - 担当が個人 (`assigneeId`) ⇒ that person edits — teammates and a creator who is not the
//     依頼者 only view;
//   - 担当がチーム (`assigneeTeamId`, #882) ⇒ any member of that team edits;
//   - 担当なし ⇒ only the creator edits.
// The owning team (`teamId`, the gantt「チーム」) grants nothing. A parent task does NOT become
// editable because a child is assigned to me — the child row is editable on its own.
import type { TeamId, UserId } from "./common";

export const TASK_EDIT_ALL_KEY = "task:edit_all" as const;

/** The task fields the rule reads. */
export interface TaskEditSubject {
  assigneeId: UserId | null;
  /** 担当チーム (#882). Optional so the rule works before/without that column. */
  assigneeTeamId?: TeamId | null;
  /** 依頼者 (#881). Optional/settable; when set, that user edits too. */
  requesterId?: UserId | null;
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

/**
 * The team whose members may edit `t`, or null. Only a team 担当 (and only when no person is
 * the 担当 — the two are exclusive, a person wins if a stale row carries both).
 */
export function taskEditTeamId(t: TaskEditSubject): TeamId | null {
  if (t.assigneeId) return null;
  return t.assigneeTeamId ?? null;
}

/** Instance-level edit check (the `task:write` key check happens before this). */
export function canEditTask(t: TaskEditSubject, editor: TaskEditor, holdsEditAll: boolean): boolean {
  if (holdsEditAll) return true;
  if (t.requesterId && t.requesterId === editor.userId) return true;
  if (t.assigneeId) return t.assigneeId === editor.userId;
  const team = taskEditTeamId(t);
  if (team) return editor.teamIds?.includes(team) ?? false;
  return t.createdBy !== undefined && t.createdBy === editor.userId;
}
