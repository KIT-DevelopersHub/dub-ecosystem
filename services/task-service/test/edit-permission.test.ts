// #881: without task:edit_all — 個人担当 ⇒ that person only, チーム担当 ⇒ that team's members,
// 担当なし ⇒ the creator. task:edit_all (admin / maintainer) edits everything.
import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { buildApp } from "../src/app";
import { makeHarness, userInit, serviceInit, type TestHarness } from "./helpers";

type TaskApp = ReturnType<typeof buildApp>;

function setup(): { h: TestHarness; app: TaskApp } {
  const h = makeHarness();
  return { h, app: buildApp(h.deps) };
}

/** alice creates a task assigned to bob; carol is a bystander. */
async function seed(app: TaskApp, over: Partial<task.CreateTaskRequest> = {}): Promise<task.Task> {
  const res = await app.request(
    "/tasks",
    userInit("POST", { eventId: "evt_1", title: "T", assigneeId: "usr_bob", ...over }, { userId: "usr_alice" }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as task.Task;
}

const as = (userId: string, method: string, body?: unknown) => userInit(method, body, { userId });

/**
 * Hand `t` to a team (#882 assigneeTeamId). Written on the stored row so this suite runs with
 * or without #882's create/PATCH support for the column.
 */
function assignToTeam(h: TestHarness, t: task.Task, teamId: string): void {
  const row = h.repo.rows.get(t.id) as (task.Task & { assigneeTeamId?: string | null }) | undefined;
  if (!row) throw new Error("no row");
  row.assigneeId = null;
  row.assigneeTeamId = teamId;
}

describe("task edit permission (#881)", () => {
  it("a bystander without task:edit_all gets 403 on PATCH and nothing changes", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(JSON.stringify(body)).toContain("not_task_assignee");
    expect((await h.repo.getById(t.id))?.title).toBe("T");
    expect(h.events.byName("task.updated")).toHaveLength(0);
  });

  it("the assignee may edit without task:edit_all", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, as("usr_bob", "PATCH", { version: 1, dueAt: "2026-12-01T00:00:00.000Z" }));
    expect(res.status).toBe(200);
  });

  it("個人担当・依頼者なし: the creator (not the assignee) gets 403 — only the assignee edits", async () => {
    const { h, app } = setup();
    const t = await seed(app, { requesterId: null });
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, as("usr_alice", "PATCH", { version: 1, title: "renamed" }));
    expect(res.status).toBe(403);
  });

  it("個人担当: a teammate of the assignee (same owning team) gets 403", async () => {
    const { h, app } = setup();
    const t = await seed(app, { teamId: "team_ops" });
    h.authz.denied.add("task:edit_all");
    h.member.teams.set("usr_dave", ["team_ops"]);
    const res = await app.request(`/tasks/${t.id}`, as("usr_dave", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(403);
    expect(h.member.lookups).toBe(0);
    expect((await h.repo.getById(t.id))?.title).toBe("T");
  });

  it("担当なし: the creator may edit; another member of the owning team may not", async () => {
    const { h, app } = setup();
    const res0 = await app.request(
      "/tasks",
      userInit("POST", { eventId: "evt_1", title: "T", teamId: "team_ops" }, { userId: "usr_alice" }),
    );
    const t = (await res0.json()) as task.Task;
    h.authz.denied.add("task:edit_all");
    h.member.teams.set("usr_dave", ["team_ops"]);
    const other = await app.request(`/tasks/${t.id}`, as("usr_dave", "PATCH", { version: 1, title: "x" }));
    expect(other.status).toBe(403);
    const mine = await app.request(`/tasks/${t.id}`, as("usr_alice", "PATCH", { version: 1, title: "renamed" }));
    expect(mine.status).toBe(200);
  });

  it("依頼者あり: the 依頼者 edits a task assigned to someone else", async () => {
    const { h, app } = setup();
    const t = await seed(app, { requesterId: "usr_rita" });
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, as("usr_rita", "PATCH", { version: 1, title: "by requester" }));
    expect(res.status).toBe(200);
    // the creator is no longer the 依頼者 ⇒ read-only
    const creator = await app.request(`/tasks/${t.id}`, as("usr_alice", "PATCH", { version: 2, title: "x" }));
    expect(creator.status).toBe(403);
  });

  it("依頼者: defaults to the creator, and can be set / cleared (persisted)", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    expect(t.requesterId).toBe("usr_alice");
    expect((await h.repo.getById(t.id))?.requesterId).toBe("usr_alice");

    const set = await app.request(`/tasks/${t.id}`, as("usr_bob", "PATCH", { version: 1, requesterId: "usr_rita" }));
    expect(set.status).toBe(200);
    expect(((await set.json()) as task.Task).requesterId).toBe("usr_rita");
    expect((await h.repo.getById(t.id))?.requesterId).toBe("usr_rita");

    const cleared = await app.request(`/tasks/${t.id}`, as("usr_bob", "PATCH", { version: 2, requesterId: null }));
    expect(cleared.status).toBe(200);
    expect((await h.repo.getById(t.id))?.requesterId).toBeNull();

    // 依頼者なしで作成もできる
    const none = await seed(app, { requesterId: null });
    expect(none.requesterId).toBeNull();
  });

  it("依頼者: an unknown user or a non-string is a 400", async () => {
    const { h, app } = setup();
    h.identity.unknown.add("usr_ghost");
    const t = await seed(app);
    const ghost = await app.request(`/tasks/${t.id}`, as("usr_bob", "PATCH", { version: 1, requesterId: "usr_ghost" }));
    expect(ghost.status).toBe(400);
    const bad = await app.request(`/tasks/${t.id}`, as("usr_bob", "PATCH", { version: 1, requesterId: 42 }));
    expect(bad.status).toBe(400);
    const onCreate = await app.request("/tasks", as("usr_alice", "POST", { eventId: "evt_1", title: "T", requesterId: "usr_ghost" }));
    expect(onCreate.status).toBe(400);
  });

  it("a holder of task:edit_all edits any task", async () => {
    const { app } = setup();
    const t = await seed(app);
    const res = await app.request(`/tasks/${t.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(200);
  });

  it("a service principal (github-sync) is not limited", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, serviceInit("PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(200);
  });

  it("a child assigned to me does not make its parent editable", async () => {
    const { h, app } = setup();
    const parent = await seed(app, { assigneeId: "usr_bob" });
    const child = await seed(app, { parentTaskId: parent.id, assigneeId: "usr_carol" });
    h.authz.denied.add("task:edit_all");
    const onParent = await app.request(`/tasks/${parent.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(onParent.status).toBe(403);
    const onChild = await app.request(`/tasks/${child.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(onChild.status).toBe(200);
  });

  it("guards archive, attachments and dependencies too", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    const other = await seed(app);
    const att = await app.request(
      `/tasks/${t.id}/attachments`,
      as("usr_bob", "POST", { kind: "url", name: "doc", url: "https://example.com" }),
    );
    expect(att.status).toBe(201);
    const attId = ((await att.json()) as task.TaskAttachment).id;
    h.authz.denied.add("task:edit_all");

    const del = await app.request(`/tasks/${t.id}`, as("usr_carol", "DELETE"));
    expect(del.status).toBe(403);
    const addAtt = await app.request(
      `/tasks/${t.id}/attachments`,
      as("usr_carol", "POST", { kind: "url", name: "doc", url: "https://example.com" }),
    );
    expect(addAtt.status).toBe(403);
    const rmAtt = await app.request(`/tasks/${t.id}/attachments/${attId}`, as("usr_carol", "DELETE"));
    expect(rmAtt.status).toBe(403);
    const putDeps = await app.request(
      `/tasks/${t.id}/dependencies`,
      as("usr_carol", "PUT", { version: 1, dependsOnIds: [other.id] }),
    );
    expect(putDeps.status).toBe(403);
    expect(await h.repo.getById(t.id)).not.toBeNull();

    // the assignee still can
    const okDeps = await app.request(`/tasks/${t.id}/dependencies`, as("usr_bob", "PUT", { version: 1, dependsOnIds: [other.id] }));
    expect(okDeps.status).toBe(200);
  });

  it("the calendar 予定 routes share the rule (a 予定 is a task)", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/calendar-events/${t.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(403);
    const mine = await app.request(`/tasks/calendar-events/${t.id}`, as("usr_bob", "PATCH", { version: 1, title: "x" }));
    expect(mine.status).toBe(200);
  });

  it("チーム担当: a member of the 担当チーム edits; a non-member (even the creator) does not", async () => {
    const { h, app } = setup();
    const t = await seed(app, { teamId: "team_pr", requesterId: null });
    assignToTeam(h, t, "team_ops");
    h.authz.denied.add("task:edit_all");
    h.member.teams.set("usr_dave", ["team_ops"]);
    h.member.teams.set("usr_erin", ["team_pr"]);
    const member = await app.request(`/tasks/${t.id}`, as("usr_dave", "PATCH", { version: 1, title: "by team" }));
    expect(member.status).toBe(200);
    const outsider = await app.request(`/tasks/${t.id}`, as("usr_erin", "PATCH", { version: 2, title: "x" }));
    expect(outsider.status).toBe(403);
    const creator = await app.request(`/tasks/${t.id}`, as("usr_alice", "PATCH", { version: 2, title: "x" }));
    expect(creator.status).toBe(403);
    expect((await h.repo.getById(t.id))?.title).toBe("by team");
  });

  it("does not look up teams for a task without a team (no member-service call)", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    h.member.teams.set("usr_carol", ["team_ops"]);
    const res = await app.request(`/tasks/${t.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(403);
    expect(h.member.lookups).toBe(0);
  });

  it("an organizer without task:edit_all cannot edit someone else's non-team task", async () => {
    // organizer keeps task:write/task:delete but (owner decision) no task:edit_all.
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, as("usr_organizer", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(403);
    const del = await app.request(`/tasks/${t.id}`, as("usr_organizer", "DELETE"));
    expect(del.status).toBe(403);
  });

  it("admin / maintainer (task:edit_all holders) edit any task — person- or team-assigned", async () => {
    const { h, app } = setup();
    const personal = await seed(app, { teamId: "team_ops" });
    const teamTask = await seed(app);
    assignToTeam(h, teamTask, "team_ops");
    h.member.teams.set("usr_admin", []);
    const res = await app.request(`/tasks/${personal.id}`, as("usr_admin", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(200);
    const res2 = await app.request(`/tasks/${teamTask.id}`, as("usr_maint", "PATCH", { version: 1, title: "x" }));
    expect(res2.status).toBe(200);
    expect(h.member.lookups).toBe(0);
  });

  it("creating a task is unchanged (task:write is enough)", async () => {
    const { h, app } = setup();
    h.authz.denied.add("task:edit_all");
    const res = await app.request("/tasks", as("usr_carol", "POST", { eventId: "evt_1", title: "new" }));
    expect(res.status).toBe(201);
  });
});
