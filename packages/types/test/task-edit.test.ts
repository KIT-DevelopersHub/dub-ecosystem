// #881: who may edit one task — edit_all, else the person 担当 only, else the 担当チーム's
// members, else (no 担当) the creator.
import { describe, it, expect } from "vitest";
import { task } from "../src/index";

describe("task.canEditTask", () => {
  it("個人担当: only that person edits — not the creator, not a teammate", () => {
    const t = { assigneeId: "usr_bob", createdBy: "usr_alice" } as const;
    expect(task.canEditTask(t, { userId: "usr_bob" }, false)).toBe(true);
    expect(task.canEditTask(t, { userId: "usr_alice" }, false)).toBe(false);
    expect(task.canEditTask(t, { userId: "usr_carol" }, false)).toBe(false);
  });

  it("個人担当: a member of the owning team (teamId) or a stale assigneeTeamId gets nothing", () => {
    const t = { assigneeId: "usr_bob", assigneeTeamId: "team_ops", teamId: "team_ops", createdBy: "usr_alice" };
    expect(task.canEditTask(t, { userId: "usr_carol", teamIds: ["team_ops"] }, false)).toBe(false);
    expect(task.taskEditTeamId(t)).toBeNull();
  });

  it("チーム担当: any member of that team edits; a non-member (even the creator) does not", () => {
    const t = { assigneeId: null, assigneeTeamId: "team_pr", teamId: "team_ops", createdBy: "usr_alice" };
    expect(task.canEditTask(t, { userId: "usr_carol", teamIds: ["team_pr"] }, false)).toBe(true);
    expect(task.canEditTask(t, { userId: "usr_dave", teamIds: ["team_ops"] }, false)).toBe(false);
    expect(task.canEditTask(t, { userId: "usr_alice" }, false)).toBe(false);
    expect(task.taskEditTeamId(t)).toBe("team_pr");
  });

  it("担当なし: only the creator edits (the owning team grants nothing)", () => {
    const t = { assigneeId: null, teamId: "team_ops", createdBy: "usr_alice" };
    expect(task.canEditTask(t, { userId: "usr_alice" }, false)).toBe(true);
    expect(task.canEditTask(t, { userId: "usr_carol", teamIds: ["team_ops"] }, false)).toBe(false);
  });

  it("依頼者あり: the 依頼者 edits too (person- or team-assigned or unassigned)", () => {
    for (const t of [
      { assigneeId: "usr_bob", requesterId: "usr_rita", createdBy: "usr_alice" },
      { assigneeId: null, assigneeTeamId: "team_pr", requesterId: "usr_rita", createdBy: "usr_alice" },
      { assigneeId: null, requesterId: "usr_rita", createdBy: "usr_alice" },
    ]) {
      expect(task.canEditTask(t, { userId: "usr_rita" }, false)).toBe(true);
    }
  });

  it("依頼者なし: being the creator alone does not open a person-assigned task", () => {
    const t = { assigneeId: "usr_bob", requesterId: null, createdBy: "usr_alice" };
    expect(task.canEditTask(t, { userId: "usr_alice" }, false)).toBe(false);
    expect(task.canEditTask(t, { userId: "usr_bob" }, false)).toBe(true);
  });

  it("task:edit_all (admin / maintainer) edits any task", () => {
    expect(task.canEditTask({ assigneeId: "usr_bob" }, { userId: "usr_admin" }, true)).toBe(true);
    expect(task.canEditTask({ assigneeId: null, assigneeTeamId: "team_pr" }, { userId: "usr_admin" }, true)).toBe(true);
  });
});
