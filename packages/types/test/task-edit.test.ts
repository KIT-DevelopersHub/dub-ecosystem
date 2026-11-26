// #881: who may edit one task — person assignee, a member of the task's team, creator, or edit_all.
import { describe, it, expect } from "vitest";
import { member, task } from "../src/index";

const base = { assigneeId: "usr_bob", createdBy: "usr_alice" } as const;

describe("task.canEditTask / isTaskAssignee", () => {
  it("person assignee and creator edit; a bystander does not", () => {
    expect(task.canEditTask(base, { userId: "usr_bob" }, false)).toBe(true);
    expect(task.canEditTask(base, { userId: "usr_alice" }, false)).toBe(true);
    expect(task.canEditTask(base, { userId: "usr_carol" }, false)).toBe(false);
    expect(task.canEditTask(base, { userId: "usr_carol" }, true)).toBe(true);
  });

  it("a member of the 所属チーム (teamId) is an assignee; a non-member is not", () => {
    const t = { ...base, teamId: "team_ops" };
    expect(task.isTaskAssignee(t, { userId: "usr_carol", teamIds: ["team_ops"] })).toBe(true);
    expect(task.isTaskAssignee(t, { userId: "usr_carol", teamIds: ["team_pr"] })).toBe(false);
    expect(task.isTaskAssignee(t, { userId: "usr_carol" })).toBe(false);
  });

  it("a member of the 担当チーム (assigneeTeamId, #882) is an assignee", () => {
    const t = { ...base, assigneeId: null, assigneeTeamId: "team_pr", teamId: "team_ops" };
    expect(task.isTaskAssignee(t, { userId: "usr_carol", teamIds: ["team_pr"] })).toBe(true);
    expect(task.isTaskAssignee(t, { userId: "usr_carol", teamIds: ["team_dev"] })).toBe(false);
    expect(task.taskTeamIds(t)).toEqual(["team_pr", "team_ops"]);
  });

  it("teamIdOfRoleId inverts teamRoleId and ignores other roles", () => {
    expect(member.teamIdOfRoleId(member.teamRoleId("team_ops"))).toBe("team_ops");
    expect(member.teamIdOfRoleId("role_auto_position_leader")).toBeNull();
    expect(member.teamIdOfRoleId("role_sys_member")).toBeNull();
    expect(member.teamIdOfRoleId("role_auto_team_")).toBeNull();
  });
});
