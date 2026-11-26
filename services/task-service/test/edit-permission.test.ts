// #881: without task:edit_all a caller edits only tasks assigned to them or created by them.
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

  it("the creator may edit without task:edit_all", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    const res = await app.request(`/tasks/${t.id}`, as("usr_alice", "PATCH", { version: 1, title: "renamed" }));
    expect(res.status).toBe(200);
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
    const mine = await app.request(`/tasks/calendar-events/${t.id}`, as("usr_alice", "PATCH", { version: 1, title: "x" }));
    expect(mine.status).toBe(200);
  });

  it("a member of the task's team edits it; a non-member does not (#881 team = role)", async () => {
    const { h, app } = setup();
    const t = await seed(app, { teamId: "team_ops" });
    h.authz.denied.add("task:edit_all");
    h.identity.teams.set("usr_dave", ["team_ops"]);
    h.identity.teams.set("usr_erin", ["team_pr"]);
    const member = await app.request(`/tasks/${t.id}`, as("usr_dave", "PATCH", { version: 1, title: "by team" }));
    expect(member.status).toBe(200);
    const outsider = await app.request(`/tasks/${t.id}`, as("usr_erin", "PATCH", { version: 2, title: "x" }));
    expect(outsider.status).toBe(403);
    expect((await h.repo.getById(t.id))?.title).toBe("by team");
  });

  it("does not look up teams for a task without a team (no extra identity call)", async () => {
    const { h, app } = setup();
    const t = await seed(app);
    h.authz.denied.add("task:edit_all");
    h.identity.teams.set("usr_carol", ["team_ops"]);
    const res = await app.request(`/tasks/${t.id}`, as("usr_carol", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(403);
    expect(h.identity.teamLookups).toBe(0);
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

  it("admin / maintainer (task:edit_all holders) edit any task, team or not", async () => {
    const { h, app } = setup();
    const t = await seed(app, { teamId: "team_ops" });
    h.identity.teams.set("usr_admin", []);
    const res = await app.request(`/tasks/${t.id}`, as("usr_admin", "PATCH", { version: 1, title: "x" }));
    expect(res.status).toBe(200);
    expect(h.identity.teamLookups).toBe(0);
  });

  it("creating a task is unchanged (task:write is enough)", async () => {
    const { h, app } = setup();
    h.authz.denied.add("task:edit_all");
    const res = await app.request("/tasks", as("usr_carol", "POST", { eventId: "evt_1", title: "new" }));
    expect(res.status).toBe(201);
  });
});
