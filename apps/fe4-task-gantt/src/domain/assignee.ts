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
