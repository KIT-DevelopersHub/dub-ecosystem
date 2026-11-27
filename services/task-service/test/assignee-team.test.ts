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
  const res = await app.request(
    "/tasks",
    userInit("POST", {
      eventId: "evt_1",
      title: "T",
      ...(over.assigneeId || over.assigneeTeamId ? {} : { assigneeId: "usr_alice" }),
      ...over,
    }),
  );
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
    const res = await app.request("/tasks", userInit("POST", { assigneeId: "usr_alice", eventId: "evt_1", title: "T", assigneeTeamId: 42 }));
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

  it("an unchanged team emits no task.assigned; PATCH assigneeTeamId=null (no person) is 400 required", async () => {
    const { h, app } = setup();
    const t = await create(app, { assigneeTeamId: "team_ops" });
    const before = h.events.byName("task.assigned").length;
    const same = (await (await patch(app, t, { assigneeTeamId: "team_ops", title: "T2" })).json()) as task.Task;
    expect(h.events.byName("task.assigned").length).toBe(before);
    const res = await patch(app, same, { assigneeTeamId: null });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('"reason":"required"');
    const after = await h.repo.getById(t.id);
    expect(after!.assigneeTeamId).toBe("team_ops");
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

// 担当は必須 (人 or チーム)。未割り当ては作れず、更新後に空になる PATCH も拒否する。
describe("担当は必須 (assignee required)", () => {
  async function seedUnassigned(h: ReturnType<typeof makeHarness>): Promise<task.Task> {
    return h.repo.insert({
      id: "task_legacy",
      eventId: "evt_1",
      title: "旧タスク",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeId: null,
      dueAt: null,
      origin: "internal",
      createdBy: "usr_alice",
      now: "2026-08-09T00:00:00Z",
    });
  }

  it("POST without a person or team is 400 VALIDATION_FAILED assigneeId/required (no event)", async () => {
    const { h, app } = setup();
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { field: string; reason: string }[] } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toContainEqual(expect.objectContaining({ field: "assigneeId", reason: "required" }));
    expect(h.events.published).toHaveLength(0);
  });

  it("POST by a service (origin=github) without an assignee is also 400", async () => {
    const { app } = setup();
    const res = await app.request("/tasks", serviceInit("POST", { eventId: "evt_1", title: "GH", origin: "github" }));
    expect(res.status).toBe(400);
  });

  it("PATCH assigneeId=null on a person-assigned task is 400 (cannot unassign)", async () => {
    const { h, app } = setup();
    const t = await create(app, { assigneeId: "usr_bob" });
    const res = await patch(app, t, { assigneeId: null });
    expect(res.status).toBe(400);
    expect((await h.repo.getById(t.id))!.assigneeId).toBe("usr_bob");
  });

  it("an existing unassigned task still reads, but an edit without choosing an assignee is 400", async () => {
    const { h, app } = setup();
    const t = await seedUnassigned(h);
    expect((await app.request(`/tasks/${t.id}`, userInit("GET"))).status).toBe(200);
    const res = await patch(app, t, { title: "変更" });
    expect(res.status).toBe(400);
    expect((await h.repo.getById(t.id))!.title).toBe("旧タスク");
    // a version-only body is still a no-op 200
    expect((await patch(app, t, {})).status).toBe(200);
  });

  it("the same edit succeeds once the PATCH also chooses an assignee (person or team)", async () => {
    const { h, app } = setup();
    const t = await seedUnassigned(h);
    const res = await patch(app, t, { title: "変更", assigneeTeamId: "team_ops" });
    expect(res.status).toBe(200);
    const after = (await res.json()) as task.Task;
    expect(after.title).toBe("変更");
    expect(after.assigneeTeamId).toBe("team_ops");
  });
});
