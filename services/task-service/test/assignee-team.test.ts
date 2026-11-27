// #882: 担当にチームを選べる (assigneeTeamId). 人 XOR チーム XOR 未割当。
import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { buildApp } from "../src/app";
import { makeHarness, userInit, serviceInit } from "./helpers";

function setup() {
  const h = makeHarness();
  return { h, app: buildApp(h.deps) };
}

async function create(app: ReturnType<typeof buildApp>, over: Partial<task.CreateTaskRequest>): Promise<task.Task> {
  const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T", ...over }));
  expect(res.status).toBe(201);
  return (await res.json()) as task.Task;
}

async function patch(app: ReturnType<typeof buildApp>, t: task.Task, body: Partial<task.UpdateTaskRequest>) {
  return app.request(`/tasks/${t.id}`, userInit("PATCH", { version: t.version, ...body }));
}

describe("担当チーム (assigneeTeamId)", () => {
  it("creates a team-assigned task and emits task.assigned with assigneeTeamId", async () => {
    const { h, app } = setup();
    const t = await create(app, { assigneeTeamId: "team_ops" });
    expect(t.assigneeTeamId).toBe("team_ops");
    expect(t.assigneeId).toBeNull();
    const assigned = h.events.byName("task.assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.payload).toEqual({ taskId: t.id, eventId: "evt_1", assigneeId: null, assigneeTeamId: "team_ops" });
  });

  it("400 assignee_conflict when both a person and a team are given", async () => {
    const { h, app } = setup();
    const res = await app.request(
      "/tasks",
      userInit("POST", { eventId: "evt_1", title: "T", assigneeId: "usr_bob", assigneeTeamId: "team_ops" }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("assignee_conflict");
    expect(h.events.published).toHaveLength(0);
  });

  it("400 when assigneeTeamId is not a string", async () => {
    const { app } = setup();
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T", assigneeTeamId: 42 }));
    expect(res.status).toBe(400);
  });

  it("PATCH to a team clears the person assignee (and vice-versa)", async () => {
    const { h, app } = setup();
    const t = await create(app, { assigneeId: "usr_bob" });
    const r1 = await patch(app, t, { assigneeTeamId: "team_ops" });
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as task.Task;
    expect(t1.assigneeTeamId).toBe("team_ops");
    expect(t1.assigneeId).toBeNull();
    expect(h.events.byName("task.assigned").at(-1)!.payload).toMatchObject({ assigneeId: null, assigneeTeamId: "team_ops" });

    const r2 = await patch(app, t1, { assigneeId: "usr_bob" });
    const t2 = (await r2.json()) as task.Task;
    expect(t2.assigneeId).toBe("usr_bob");
    expect(t2.assigneeTeamId).toBeNull();
  });

  it("PATCH assigneeTeamId=null unassigns; an unchanged team emits no task.assigned", async () => {
    const { h, app } = setup();
    const t = await create(app, { assigneeTeamId: "team_ops" });
    const before = h.events.byName("task.assigned").length;
    const same = (await (await patch(app, t, { assigneeTeamId: "team_ops", title: "T2" })).json()) as task.Task;
    expect(h.events.byName("task.assigned").length).toBe(before);
    const cleared = (await (await patch(app, same, { assigneeTeamId: null })).json()) as task.Task;
    expect(cleared.assigneeTeamId).toBeNull();
    expect(cleared.assigneeId).toBeNull();
  });

  it("400 assignee_conflict on PATCH with both set", async () => {
    const { app } = setup();
    const t = await create(app, {});
    const res = await patch(app, t, { assigneeId: "usr_bob", assigneeTeamId: "team_ops" });
    expect(res.status).toBe(400);
  });

  it("GET /tasks?assigneeId=me&assigneeTeamId=a,b returns mine ∪ my teams' tasks (My Tasks 担当)", async () => {
    const { app } = setup();
    const mine = await create(app, { assigneeId: "usr_alice" });
    const teamA = await create(app, { assigneeTeamId: "team_a" });
    const teamB = await create(app, { assigneeTeamId: "team_b" });
    await create(app, { assigneeTeamId: "team_other" });
    await create(app, { assigneeId: "usr_bob" });
    const res = await app.request("/tasks?assigneeId=usr_alice&assigneeTeamId=team_a,team_b", userInit("GET"));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as task.ListTasksResponse).items.map((t) => t.id).sort();
    expect(ids).toEqual([mine.id, teamA.id, teamB.id].sort());
  });

  it("GET /tasks?assigneeTeamId=… alone is a team scope (no eventId needed)", async () => {
    const { app } = setup();
    const teamA = await create(app, { assigneeTeamId: "team_a" });
    await create(app, { assigneeId: "usr_bob" });
    const res = await app.request("/tasks?assigneeTeamId=team_a", userInit("GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as task.ListTasksResponse).items.map((t) => t.id)).toEqual([teamA.id]);
  });

  it("github-origin task: handing it to a team (clearing the protected person) is 422 for users", async () => {
    const { app } = setup();
    const res = await app.request(
      "/tasks",
      serviceInit("POST", { eventId: "evt_1", title: "GH", origin: "github", assigneeId: "usr_bob" }),
    );
    const gh = (await res.json()) as task.Task;
    const r = await patch(app, gh, { assigneeTeamId: "team_ops" });
    expect(r.status).toBe(422);
  });
});
