// 担当 = 人 XOR チーム XOR 未割当 (#882). The picker encodes both kinds into one
// dropdown value ("user:<id>" / "team:<id>" / "" = 未割当); the API keeps two
// fields (assigneeId / assigneeTeamId) that the server keeps mutually exclusive.
import type { common, identity, task, team } from "@dub/types";

export interface Assignee {
  assigneeId: common.UserId | null;
  assigneeTeamId: common.TeamId | null;
}

export const UNASSIGNED: Assignee = { assigneeId: null, assigneeTeamId: null };

export function encodeAssignee(a: Assignee): string {
  if (a.assigneeId) return `user:${a.assigneeId}`;
  if (a.assigneeTeamId) return `team:${a.assigneeTeamId}`;
  return "";
}

export function decodeAssignee(v: string): Assignee {
  if (v.startsWith("user:")) return { assigneeId: v.slice(5), assigneeTeamId: null };
  if (v.startsWith("team:")) return { assigneeId: null, assigneeTeamId: v.slice(5) };
  return UNASSIGNED;
}

/** Display name of a task's 担当 — a person's name, or 「<チーム名>（チーム）」. */
export function assigneeLabel(
  t: Pick<task.Task, "assigneeId" | "assigneeTeamId">,
  userName: (id: common.UserId) => string | undefined,
  teams: readonly Pick<team.Team, "id" | "name">[],
): string | undefined {
  if (t.assigneeId) return userName(t.assigneeId);
  if (t.assigneeTeamId) {
    const name = teams.find((x) => x.id === t.assigneeTeamId)?.name;
    return name ? `${name}（チーム）` : undefined;
  }
  return undefined;
}

/** Is this task assigned to me — directly or through one of my teams? */
export function isAssignedToMe(
  t: Pick<task.Task, "assigneeId" | "assigneeTeamId">,
  me: common.UserId | null,
  myTeamIds: readonly common.TeamId[],
): boolean {
  return (!!me && t.assigneeId === me) || (!!t.assigneeTeamId && myTeamIds.includes(t.assigneeTeamId));
}

export type AssigneeUser = Pick<identity.UserSummary, "id" | "displayName">;

/** 人 → 所属チーム (identity userId → team ids). Empty when unknown / not permitted. */
export type UserTeamsLookup = ReadonlyMap<common.UserId, readonly common.TeamId[]>;

/**
 * The task's team (teamId) implied by its 担当 — the チーム field is no longer shown, so it
 * follows the 担当:
 *  - チーム担当 → that team.
 *  - 人の担当 → one of the person's teams: keep the current team if the person is in it,
 *    otherwise the first of the person's teams in `teamOrder` (the team list order).
 *    A person with no known team (or teams not in `teamOrder`) leaves it unchanged.
 *  - 未割当 → unchanged.
 * Callers skip this while 親タスク is set (親子は同一チーム wins).
 */
export function deriveTaskTeam(
  next: Assignee,
  currentTeamId: common.TeamId | null,
  userTeams: UserTeamsLookup,
  teamOrder: readonly common.TeamId[],
): common.TeamId | null {
  if (next.assigneeTeamId) return next.assigneeTeamId;
  if (!next.assigneeId) return currentTeamId;
  const theirs = userTeams.get(next.assigneeId) ?? [];
  if (currentTeamId && theirs.includes(currentTeamId)) return currentTeamId;
  return teamOrder.find((id) => theirs.includes(id)) ?? currentTeamId;
}
