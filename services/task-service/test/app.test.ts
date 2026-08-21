import { describe, it, expect } from "vitest";
import type { Hono } from "hono";
import type { task } from "@dub/types";
import { buildApp } from "../src/app";
import { makeHarness, userInit, serviceInit, type TestHarness } from "./helpers";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function create(
  app: Hono,
  over: Partial<task.CreateTaskRequest> = {},
  init: (method: string, body?: unknown) => RequestInit = userInit,
): Promise<task.Task> {
  const res = await app.request("/tasks", init("POST", { eventId: "evt_1", title: "T", ...over }));
  expect(res.status).toBe(201);
  return (await res.json()) as task.Task;
}

function setup(): { h: TestHarness; app: Hono } {
  const h = makeHarness();
  return { h, app: buildApp(h.deps) };
}

describe("POST /tasks", () => {
  it("creates (201, version=1) and emits task.created with a ULID envelope id", async () => {
    const { h, app } = setup();
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "Hello" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as task.Task;
    expect(body.version).toBe(1);
    expect(body.status).toBe("todo");
    expect(body.priority).toBe("medium");
    expect(body.origin).toBe("internal");
    const created = h.events.byName("task.created");
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toMatch(ULID_RE);
    expect(created[0]!.payload).toEqual({ taskId: body.id, eventId: "evt_1" });
    expect(created[0]!.actorId).toBe("usr_alice");
  });

  it("also emits task.assigned when created with an assignee", async () => {
    const { h, app } = setup();
    const body = await create(app, { assigneeId: "usr_bob" });
    const assigned = h.events.byName("task.assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.payload).toEqual({ taskId: body.id, eventId: "evt_1", assigneeId: "usr_bob" });
  });

  it("404 TASK_EVENT_NOT_FOUND when the event does not exist (no event emitted)", async () => {
    const { h, app } = setup();
    h.eventClient.missing.add("evt_x");
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_x", title: "T" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_EVENT_NOT_FOUND");
    expect(h.events.published).toHaveLength(0);
  });

  it("422 TASK_EVENT_ARCHIVED when creating under an archived event", async () => {
    const { h, app } = setup();
    h.eventClient.archived.add("evt_1");
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_EVENT_ARCHIVED");
  });

  it("400 VALIDATION_FAILED when a normal client specifies origin", async () => {
    const { app } = setup();
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T", origin: "github" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("service role may create origin=github with actorId=service:github-sync", async () => {
    const { h, app } = setup();
    const body = await create(app, { origin: "github", title: "gh" }, serviceInit);
    expect(body.origin).toBe("github");
    expect(h.events.byName("task.created")[0]!.actorId).toBe("service:github-sync");
  });

  it("400 when title is missing or too long", async () => {
    const { app } = setup();
    const long = "x".repeat(201);
    const r1 = await app.request("/tasks", userInit("POST", { eventId: "evt_1" }));
    const r2 = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: long }));
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });
});

describe("PATCH /tasks/:id", () => {
  it("assignee change emits task.assigned (previous/new correct)", async () => {
    const { h, app } = setup();
    const t = await create(app);
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1, assigneeId: "usr_bob" }));
    expect(res.status).toBe(200);
    const assigned = h.events.byName("task.assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.payload).toEqual({ taskId: t.id, eventId: "evt_1", assigneeId: "usr_bob" });
  });

  it("status transition todo -> in_progress -> done emits task.status_changed", async () => {
    const { h, app } = setup();
    const t = await create(app);
    const r1 = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1, status: "in_progress" }));
    expect(r1.status).toBe(200);
    const r2 = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 2, status: "done" }));
    expect(r2.status).toBe(200);
    const changed = h.events.byName("task.status_changed");
    expect(changed).toHaveLength(2);
    expect(changed[0]!.payload).toMatchObject({ previousStatus: "todo", status: "in_progress" });
    expect(changed[1]!.payload).toMatchObject({ previousStatus: "in_progress", status: "done" });
  });

  it("409 TASK_INVALID_STATUS_TRANSITION on an illegal move (cancelled -> in_progress)", async () => {
    const { app } = setup();
    const t = await create(app);
    await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1, status: "cancelled" }));
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 2, status: "in_progress" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_INVALID_STATUS_TRANSITION");
  });

  it("409 TASK_VERSION_CONFLICT on a stale version (DB unchanged)", async () => {
    const { h, app } = setup();
    const t = await create(app);
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 99, title: "new" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_VERSION_CONFLICT");
    const after = await h.repo.getById(t.id);
    expect(after!.title).toBe("T");
    expect(after!.version).toBe(1);
  });

  it("emits task.updated with the changed field list", async () => {
    const { h, app } = setup();
    const t = await create(app);
    await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1, title: "new", dueAt: "2026-09-01T00:00:00Z" }));
    const updated = h.events.byName("task.updated");
    expect(updated).toHaveLength(1);
    expect((updated[0]!.payload as { changed: string[] }).changed.sort()).toEqual(["dueAt", "title"]);
  });
});

describe("origin=github protection", () => {
  async function ghTask(h: TestHarness, app: Hono): Promise<task.Task> {
    return create(app, { origin: "github", title: "gh" }, serviceInit);
  }

  it("422 TASK_GITHUB_ORIGIN_READONLY when a normal user edits a protected field", async () => {
    const { h, app } = setup();
    const t = await ghTask(h, app);
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: t.version, title: "hacked" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_GITHUB_ORIGIN_READONLY");
  });

  it("422 TASK_GITHUB_ORIGIN_READONLY when a normal user edits priority (protected, 6-field 凍結)", async () => {
    const { h, app } = setup();
    const t = await ghTask(h, app);
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: t.version, priority: "high" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_GITHUB_ORIGIN_READONLY");
  });

  it("service role may write protected fields on a github task", async () => {
    const { h, app } = setup();
    const t = await ghTask(h, app);
    const res = await app.request(`/tasks/${t.id}`, serviceInit("PATCH", { version: t.version, title: "synced" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as task.Task).title).toBe("synced");
  });
});

describe("PUT /tasks/:id/dependencies", () => {
  it("replaces dependencies and emits task.dependency_changed + audit", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A" });
    const b = await create(app, { title: "B" });
    const res = await app.request(`/tasks/${a.id}/dependencies`, userInit("PUT", { version: a.version, dependsOnIds: [b.id] }));
    expect(res.status).toBe(200);
    const evt = h.events.byName("task.dependency_changed");
    expect(evt).toHaveLength(1);
    expect(evt[0]!.payload).toMatchObject({ taskId: a.id, added: [b.id], removed: [] });
    expect(h.audit.records.some((r) => r.action === "task.dependency.replaced")).toBe(true);
  });

  it("supports seeded task ids without the task_ prefix (GET + first dependency add persists) [regression]", async () => {
    // Real conference data was seeded with human-readable ids (e.g. "lmbconf-wp-01"),
    // NOT the task_<ULID> the API mints. A premature `id.startsWith("task_")` guard
    // 404'd every single-item route on those tasks, so 「先行タスクを保存」 silently
    // failed for 212/215 conference tasks. Ids are opaque; the DB is the source of truth.
    const { h, app } = setup();
    const now = "2026-08-19T00:00:00.000Z";
    const base = {
      eventId: "evt_1",
      description: null,
      status: "todo" as const,
      priority: "medium" as const,
      assigneeId: null,
      dueAt: null,
      origin: "internal" as const,
      createdBy: "usr_alice",
      now,
    };
    const pred = await h.repo.insert({ ...base, id: "lmbconf-wp-00", title: "会計: 法人設立" });
    const succ = await h.repo.insert({ ...base, id: "lmbconf-wp-01", title: "会計: 設立後の届出" });

    // GET on a non-task_ id must resolve (was 404 via the prefix guard).
    const got = await app.request(`/tasks/${succ.id}`, userInit("GET"));
    expect(got.status).toBe(200);

    // First dependency add on a task that had none must persist.
    const res = await app.request(
      `/tasks/${succ.id}/dependencies`,
      userInit("PUT", { version: succ.version, dependsOnIds: [pred.id] }),
    );
    expect(res.status).toBe(200);
    expect(await h.repo.getDependsOn(succ.id)).toEqual([pred.id]);
    expect(h.events.byName("task.dependency_changed")).toHaveLength(1);
  });

  it("409 TASK_DEPENDENCY_CYCLE (A->B->C->A); dependencies unchanged, no event", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A" });
    const b = await create(app, { title: "B" });
    const c = await create(app, { title: "C" });
    await app.request(`/tasks/${b.id}/dependencies`, userInit("PUT", { version: b.version, dependsOnIds: [c.id] }));
    await app.request(`/tasks/${c.id}/dependencies`, userInit("PUT", { version: c.version, dependsOnIds: [a.id] }));
    h.events.published = [];
    const res = await app.request(`/tasks/${a.id}/dependencies`, userInit("PUT", { version: a.version, dependsOnIds: [b.id] }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_DEPENDENCY_CYCLE");
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
    expect(h.events.byName("task.dependency_changed")).toHaveLength(0);
  });

  it("400 VALIDATION_FAILED when a dependsOn target does not exist (gantt-calc unknownTaskIds)", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A" });
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: ["task_ghost"] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
    expect(h.events.byName("task.dependency_changed")).toHaveLength(0);
  });

  it("400 VALIDATION_FAILED when a dependsOn target belongs to another event", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A", eventId: "evt_1" });
    const other = await create(app, { title: "X", eventId: "evt_2" });
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [other.id] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
  });

  it("400 VALIDATION_FAILED when a dependsOn target is archived", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A" });
    const b = await create(app, { title: "B" });
    await app.request(`/tasks/${b.id}`, userInit("DELETE"));
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [b.id] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
  });
});

// Cross-scope deps / ADR-0007: dependencies (arrows) are same-team only, but may span
// DIFFERENT WBS scopes (別階層) within that team. Cross-team work goes through the
// request/approval flow, never a dependency edge.
describe("PUT /tasks/:id/dependencies — same-team gate (ADR-0007)", () => {
  it("200 same team: an edge between two tasks of the same team is allowed", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A", teamId: "team_dev" });
    const b = await create(app, { title: "B", teamId: "team_dev" });
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [b.id] }),
    );
    expect(res.status).toBe(200);
    expect(await h.repo.getDependsOn(a.id)).toEqual([b.id]);
    expect(h.events.byName("task.dependency_changed")).toHaveLength(1);
  });

  it("400 cross_team_not_allowed: a task cannot depend on another team's task", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A", teamId: "team_dev" });
    const b = await create(app, { title: "B", teamId: "team_sponsor" });
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [b.id] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: Array<{ field: string; reason: string }> } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toEqual([
      expect.objectContaining({ field: "dependsOnIds", reason: "cross_team_not_allowed" }),
    ]);
    // 门番 rejected: nothing persisted, no event emitted.
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
    expect(h.events.byName("task.dependency_changed")).toHaveLength(0);
  });

  it("200 null teams: two team-less (team_id=null) tasks may still depend (back-compat)", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A" }); // no teamId ⇒ null
    const b = await create(app, { title: "B" });
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [b.id] }),
    );
    expect(res.status).toBe(200);
    expect(await h.repo.getDependsOn(a.id)).toEqual([b.id]);
  });

  it("400 cross_team_not_allowed: a one-sided null team is a mismatch", async () => {
    const { h, app } = setup();
    const a = await create(app, { title: "A", teamId: "team_dev" });
    const b = await create(app, { title: "B" }); // team_id=null
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [b.id] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
  });
});

describe("DELETE /tasks/:id (archive)", () => {
  it("archives, emits task.archived, then GET is 404 and list hides it (includeArchived reveals)", async () => {
    const { h, app } = setup();
    const t = await create(app);
    const del = await app.request(`/tasks/${t.id}`, userInit("DELETE"));
    expect(del.status).toBe(200);
    expect(h.events.byName("task.archived")).toHaveLength(1);

    const get = await app.request(`/tasks/${t.id}`, userInit("GET"));
    expect(get.status).toBe(404);

    const listed = await app.request(`/tasks?eventId=evt_1`, userInit("GET"));
    expect(((await listed.json()) as task.ListTasksResponse).items).toHaveLength(0);

    const inclArch = await app.request(`/tasks?eventId=evt_1&includeArchived=true`, userInit("GET"));
    expect(((await inclArch.json()) as task.ListTasksResponse).items).toHaveLength(1);
  });
});

describe("GET /tasks (list + paging)", () => {
  it("filters by assignee+status and paginates without dup/loss", async () => {
    const { app } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await create(app, { title: `T${i}`, assigneeId: "usr_bob" });
      ids.push(t.id);
    }
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url = `/tasks?eventId=evt_1&assigneeId=usr_bob&status=todo&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await app.request(url, userInit("GET"));
      const page = (await res.json()) as task.ListTasksResponse;
      collected.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(collected.sort()).toEqual([...ids].sort());
    expect(new Set(collected).size).toBe(ids.length);
  });

  it("400 when eventId is omitted and it is not a self (assignee) query", async () => {
    const { app } = setup();
    const res = await app.request(`/tasks?assigneeId=usr_other`, userInit("GET", undefined, { userId: "usr_alice" }));
    expect(res.status).toBe(400);
  });

  it("allows omitting eventId for the caller's own tasks (/me)", async () => {
    const { app } = setup();
    await create(app, { assigneeId: "usr_alice" });
    const res = await app.request(`/tasks?assigneeId=usr_alice`, userInit("GET", undefined, { userId: "usr_alice" }));
    expect(res.status).toBe(200);
  });

  it("exposes createdBy (the requester / from) on created + listed tasks", async () => {
    const { app } = setup();
    const t = await create(app, { assigneeId: "usr_bob" }); // creator = usr_alice (userInit default)
    expect(t.createdBy).toBe("usr_alice");
    const res = await app.request(`/tasks?eventId=evt_1`, userInit("GET"));
    const body = (await res.json()) as task.ListTasksResponse;
    expect(body.items[0]!.createdBy).toBe("usr_alice");
  });

  it("allows omitting eventId for tasks the caller issued (createdById=self, 依頼 lens)", async () => {
    const { app } = setup();
    // usr_alice issues a task assigned to someone else.
    await create(app, { assigneeId: "usr_bob" }, (m, b) => userInit(m, b, { userId: "usr_alice" }));
    const res = await app.request(
      `/tasks?createdById=usr_alice`,
      userInit("GET", undefined, { userId: "usr_alice" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as task.ListTasksResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.assigneeId).toBe("usr_bob");
    expect(body.items[0]!.createdBy).toBe("usr_alice");
  });

  it("400 when eventId omitted and createdById is another user (no cross-user leak)", async () => {
    const { app } = setup();
    const res = await app.request(
      `/tasks?createdById=usr_other`,
      userInit("GET", undefined, { userId: "usr_alice" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("routing + authz + correlation", () => {
  it("GET /tasks/dependencies is not captured by /tasks/:id", async () => {
    const { app } = setup();
    const a = await create(app, { title: "A" });
    const b = await create(app, { title: "B" });
    await app.request(`/tasks/${a.id}/dependencies`, userInit("PUT", { version: a.version, dependsOnIds: [b.id] }));
    const res = await app.request(`/tasks/dependencies?eventId=evt_1`, userInit("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: task.TaskDependency[] };
    expect(body.items).toEqual([{ taskId: a.id, dependsOnId: b.id }]);
  });

  it("403 FORBIDDEN when the user lacks task:write", async () => {
    const { h, app } = setup();
    h.authz.denied.add("task:write");
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }));
    expect(res.status).toBe(403);
  });

  it("401 when no trusted principal header is present", async () => {
    const { app } = setup();
    const res = await app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", "x-dub-request-id": "r" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("propagates x-dub-request-id into the event envelope requestId", async () => {
    const { h, app } = setup();
    await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }, { requestId: "req_custom" }));
    expect(h.events.byName("task.created")[0]!.requestId).toBe("req_custom");
  });
});

// Documented contract branches not exercised above (task-service.md §4). These lock in
// the field-level validation reasons and per-endpoint guards so a regression in the
// error contract fails loudly.
type ErrEnvelope = { error: { code: string; details?: unknown } };
async function errOf(res: Response): Promise<ErrEnvelope["error"]> {
  return ((await res.json()) as ErrEnvelope).error;
}
function hasFieldReason(details: unknown, field: string, reason: string): boolean {
  return (
    Array.isArray(details) &&
    details.some(
      (d) =>
        (d as { field?: string }).field === field && (d as { reason?: string }).reason === reason,
    )
  );
}

describe("contract branches — validation + guards", () => {
  it("POST 400 assigneeId not_found when the assignee does not exist (no event emitted) [§4.2]", async () => {
    const { h, app } = setup();
    h.identity.unknown.add("usr_ghost");
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T", assigneeId: "usr_ghost" }));
    expect(res.status).toBe(400);
    const e = await errOf(res);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(hasFieldReason(e.details, "assigneeId", "not_found")).toBe(true);
    expect(h.events.published).toHaveLength(0);
  });

  it("PATCH 400 assigneeId not_found; task left unchanged [§4.4]", async () => {
    const { h, app } = setup();
    const res0 = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }));
    const t = (await res0.json()) as task.Task;
    h.identity.unknown.add("usr_ghost");
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1, assigneeId: "usr_ghost" }));
    expect(res.status).toBe(400);
    expect((await errOf(res)).code).toBe("VALIDATION_FAILED");
    const after = await h.repo.getById(t.id);
    expect(after!.assigneeId).toBeNull();
    expect(after!.version).toBe(1);
  });

  it("PATCH 400 when version is missing [§4.4]", async () => {
    const { h, app } = setup();
    const res0 = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }));
    const t = (await res0.json()) as task.Task;
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { title: "x" }));
    expect(res.status).toBe(400);
    const e = await errOf(res);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(hasFieldReason(e.details, "version", "required")).toBe(true);
  });

  it("PATCH version-only body is a no-op that returns the current task (no events) [§4.4]", async () => {
    const { h, app } = setup();
    const res0 = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T" }));
    const t = (await res0.json()) as task.Task;
    h.events.published = [];
    const res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as task.Task;
    expect(body.version).toBe(1);
    expect(body.title).toBe("T");
    expect(h.events.published).toHaveLength(0);
  });

  it("GET 404 TASK_NOT_FOUND for a malformed (non task_-prefixed) id [§4.3]", async () => {
    const { app } = setup();
    const res = await app.request("/tasks/not-a-task-id", userInit("GET"));
    expect(res.status).toBe(404);
    expect((await errOf(res)).code).toBe("TASK_NOT_FOUND");
  });

  it("GET list 400 limit too_large when limit > 200 [§4.1]", async () => {
    const { app } = setup();
    const res = await app.request("/tasks?eventId=evt_1&limit=201", userInit("GET"));
    expect(res.status).toBe(400);
    const e = await errOf(res);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(hasFieldReason(e.details, "limit", "too_large")).toBe(true);
  });

  it("GET list 400 when a status filter value is not a valid TaskStatus [§4.1]", async () => {
    const { app } = setup();
    const res = await app.request("/tasks?eventId=evt_1&status=todo,bogus", userInit("GET"));
    expect(res.status).toBe(400);
    const e = await errOf(res);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(hasFieldReason(e.details, "status", "invalid_enum")).toBe(true);
  });

  it("GET list 403 when includeArchived=true but the caller lacks task:delete [§4.1]", async () => {
    const { h, app } = setup();
    h.authz.denied.add("task:delete");
    const res = await app.request("/tasks?eventId=evt_1&includeArchived=true", userInit("GET"));
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe("FORBIDDEN");
  });

  it("GET /tasks/dependencies 400 when eventId is absent [§4.7]", async () => {
    const { app } = setup();
    const res = await app.request("/tasks/dependencies", userInit("GET"));
    expect(res.status).toBe(400);
    const e = await errOf(res);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(hasFieldReason(e.details, "eventId", "required")).toBe(true);
  });

  it("PUT dependencies 400 self_dependency when the task depends on itself [§4.6]", async () => {
    const { h, app } = setup();
    const res0 = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "A" }));
    const a = (await res0.json()) as task.Task;
    const res = await app.request(
      `/tasks/${a.id}/dependencies`,
      userInit("PUT", { version: a.version, dependsOnIds: [a.id] }),
    );
    expect(res.status).toBe(400);
    const e = await errOf(res);
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(hasFieldReason(e.details, "dependsOnIds", "self_dependency")).toBe(true);
    expect(await h.repo.getDependsOn(a.id)).toEqual([]);
  });
});

describe("task attachments", () => {
  it("POST adds a url attachment (201, fileId null) and GET lists it", async () => {
    const { app } = setup();
    const t = await create(app);
    const res = await app.request(
      `/tasks/${t.id}/attachments`,
      userInit("POST", { kind: "url", name: "資料リンク", url: "https://example.com/doc" }),
    );
    expect(res.status).toBe(201);
    const att = (await res.json()) as task.TaskAttachment;
    expect(att.kind).toBe("url");
    expect(att.fileId).toBeNull();
    expect(att.taskId).toBe(t.id);

    const list = await app.request(`/tasks/${t.id}/attachments`, userInit("GET"));
    expect(list.status).toBe(200);
    const body = (await list.json()) as task.ListTaskAttachmentsResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.name).toBe("資料リンク");
  });

  it("POST adds a file attachment carrying fileId + display meta", async () => {
    const { app } = setup();
    const t = await create(app);
    const res = await app.request(
      `/tasks/${t.id}/attachments`,
      userInit("POST", {
        kind: "file",
        name: "図.png",
        url: "/api/v1/files/file_1/download",
        fileId: "file_1",
        mimeType: "image/png",
        sizeBytes: 1234,
      }),
    );
    expect(res.status).toBe(201);
    const att = (await res.json()) as task.TaskAttachment;
    expect(att.fileId).toBe("file_1");
    expect(att.mimeType).toBe("image/png");
    expect(att.sizeBytes).toBe(1234);
  });

  it("400 on a url-kind attachment whose url is not http(s) (no javascript: etc.)", async () => {
    const { app } = setup();
    const t = await create(app);
    const res = await app.request(
      `/tasks/${t.id}/attachments`,
      userInit("POST", { kind: "url", name: "x", url: "javascript:alert(1)" }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when attaching to a task that does not exist", async () => {
    const { app } = setup();
    const res = await app.request(
      `/tasks/task_missing/attachments`,
      userInit("POST", { kind: "url", name: "x", url: "https://example.com" }),
    );
    expect(res.status).toBe(404);
  });

  it("DELETE soft-removes an attachment so it drops out of the list", async () => {
    const { app } = setup();
    const t = await create(app);
    const add = await app.request(
      `/tasks/${t.id}/attachments`,
      userInit("POST", { kind: "url", name: "x", url: "https://example.com" }),
    );
    const att = (await add.json()) as task.TaskAttachment;
    const del = await app.request(`/tasks/${t.id}/attachments/${att.id}`, userInit("DELETE"));
    expect(del.status).toBe(200);
    const list = await app.request(`/tasks/${t.id}/attachments`, userInit("GET"));
    const body = (await list.json()) as task.ListTaskAttachmentsResponse;
    expect(body.items).toHaveLength(0);
  });

  it("403 when the caller lacks task:write", async () => {
    const { h, app } = setup();
    const t = await create(app);
    h.authz.denied.add("task:write");
    const res = await app.request(
      `/tasks/${t.id}/attachments`,
      userInit("POST", { kind: "url", name: "x", url: "https://example.com" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("WBS parent / team / wbs persistence (F5 — was untested; in-memory repo dropped them)", () => {
  async function get(app: Hono, id: string) {
    const res = await app.request(`/tasks/${id}`, userInit("GET"));
    return { status: res.status, body: (await res.json()) as task.Task & { parentTaskId?: string | null; teamId?: string | null; wbs?: string | null } };
  }

  it("persists parentTaskId/teamId/wbs on create and echoes them on read", async () => {
    const { app } = setup();
    const parent = await create(app, { title: "親" });
    const child = await create(app, { title: "子", parentTaskId: parent.id, teamId: "team_dev", wbs: "1.2.3" } as Partial<task.CreateTaskRequest>);
    const read = await get(app, child.id);
    expect(read.status).toBe(200);
    expect(read.body.parentTaskId).toBe(parent.id);
    expect(read.body.teamId).toBe("team_dev");
    expect(read.body.wbs).toBe("1.2.3");
  });

  it("re-parents and detaches via PATCH parentTaskId", async () => {
    const { app } = setup();
    const a = await create(app, { title: "A" });
    const b = await create(app, { title: "B" });
    const c = await create(app, { title: "C" });
    // attach C under A
    let res = await app.request(`/tasks/${c.id}`, userInit("PATCH", { version: c.version, parentTaskId: a.id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { parentTaskId?: string | null }).parentTaskId).toBe(a.id);
    // move C under B
    res = await app.request(`/tasks/${c.id}`, userInit("PATCH", { version: c.version + 1, parentTaskId: b.id }));
    expect(((await res.json()) as { parentTaskId?: string | null }).parentTaskId).toBe(b.id);
    // detach to top-level
    res = await app.request(`/tasks/${c.id}`, userInit("PATCH", { version: c.version + 2, parentTaskId: null }));
    expect(((await res.json()) as { parentTaskId?: string | null }).parentTaskId).toBeNull();
  });

  it("persists startAt on create, updates + clears it via PATCH, and echoes it on read (PR-C)", async () => {
    const { h, app } = setup();
    const t = await create(app, { startAt: "2026-08-05T00:00:00Z", dueAt: "2026-08-10T00:00:00Z" } as Partial<task.CreateTaskRequest>);
    expect((await get(app, t.id)).body.startAt).toBe("2026-08-05T00:00:00Z");

    // move the start; task.updated must report startAt as a changed field (→ gantt cache purge)
    let res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 1, startAt: "2026-08-07T00:00:00Z" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as task.Task).startAt).toBe("2026-08-07T00:00:00Z");
    expect(h.events.byName("task.updated").at(-1)!.payload).toMatchObject({ changed: ["startAt"] });

    // clear it (null)
    res = await app.request(`/tasks/${t.id}`, userInit("PATCH", { version: 2, startAt: null }));
    expect(((await res.json()) as task.Task).startAt).toBeNull();
  });

  it("400 on a non-ISO startAt", async () => {
    const { app } = setup();
    const res = await app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T", startAt: "nope" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });
});

// send / receive (ADR-0007): POST /task-requests branches server-side on team membership.
// Default caller is usr_alice (userInit). member.teams maps identityUserId → teamIds.
describe("POST /task-requests (send / 送る)", () => {
  const issue = (
    app: Hono,
    body: Record<string, unknown>,
    init: (method: string, body?: unknown) => RequestInit = userInit,
  ) => app.request("/task-requests", init("POST", body));

  it("self → materialises a task immediately (kind:task), assigned to the caller", async () => {
    const { h, app } = setup();
    const res = await issue(app, { toUserId: "usr_alice", title: "自分用タスク", eventId: "evt_1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as task.IssueTaskRequestResponse;
    expect(body.kind).toBe("task");
    if (body.kind !== "task") throw new Error("expected task");
    expect(body.task.assigneeId).toBe("usr_alice");
    expect(body.task.createdBy).toBe("usr_alice");
    expect(h.events.byName("task.created")).toHaveLength(1);
    expect(h.events.byName("task.assigned")).toHaveLength(1);
    expect(h.events.byName("task.request.created")).toHaveLength(0);
    expect(h.repo.requests.size).toBe(0);
  });

  it("same team → materialises a task immediately, team = the shared team", async () => {
    const { h, app } = setup();
    h.member.teams.set("usr_alice", ["team_dev"]);
    h.member.teams.set("usr_bob", ["team_dev", "team_other"]);
    const res = await issue(app, { toUserId: "usr_bob", title: "実装おねがい", eventId: "evt_1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as task.IssueTaskRequestResponse;
    if (body.kind !== "task") throw new Error("expected task");
    expect(body.task.assigneeId).toBe("usr_bob");
    expect(body.task.teamId).toBe("team_dev"); // the intersection
    expect(h.repo.requests.size).toBe(0);
  });

  it("other team → creates a pending request (kind:request) + task.request.created, no task", async () => {
    const { h, app } = setup();
    h.member.teams.set("usr_alice", ["team_dev"]);
    h.member.teams.set("usr_bob", ["team_sponsor"]);
    const res = await issue(app, { toUserId: "usr_bob", title: "スポンサー確認", eventId: "evt_1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as task.IssueTaskRequestResponse;
    expect(body.kind).toBe("request");
    if (body.kind !== "request") throw new Error("expected request");
    expect(body.request).toMatchObject({
      state: "pending",
      fromUserId: "usr_alice",
      toUserId: "usr_bob",
      fromTeamId: "team_dev",
      toTeamId: "team_sponsor",
    });
    expect(h.events.byName("task.request.created")).toHaveLength(1);
    expect(h.events.byName("task.request.created")[0]!.payload).toMatchObject({
      requestId: body.request.id,
      fromUserId: "usr_alice",
      toUserId: "usr_bob",
    });
    expect(h.events.byName("task.created")).toHaveLength(0);
    expect(h.repo.requests.size).toBe(1);
  });

  it("400 VALIDATION_FAILED when toUserId or title is missing", async () => {
    const { app } = setup();
    expect((await issue(app, { title: "no target" })).status).toBe(400);
    expect((await issue(app, { toUserId: "usr_bob" })).status).toBe(400);
  });

  it("400 when the receiver does not exist", async () => {
    const { h, app } = setup();
    h.identity.unknown.add("usr_ghost");
    const res = await issue(app, { toUserId: "usr_ghost", title: "宛先不明" });
    expect(res.status).toBe(400);
  });

  it("400 when a service principal tries to issue (no from identity)", async () => {
    const { app } = setup();
    const res = await issue(app, { toUserId: "usr_bob", title: "svc" }, serviceInit);
    expect(res.status).toBe(400);
  });
});

// GET /task-requests (incoming/outgoing) + GET /task-requests/:id. Default caller usr_alice.
describe("GET /task-requests (list + one)", () => {
  const seed = (h: TestHarness, id: string, from: string, to: string, over: Record<string, unknown> = {}) =>
    h.repo.insertRequest({
      id,
      eventId: "evt_1",
      fromUserId: from,
      toUserId: to,
      fromTeamId: null,
      toTeamId: null,
      title: id,
      description: null,
      priority: "medium",
      dueAt: null,
      sourceTaskId: null,
      now: "2026-08-20T00:00:00.000Z",
      ...over,
    });

  it("box=incoming returns only requests addressed to the caller; outgoing only from the caller", async () => {
    const { h, app } = setup();
    await seed(h, "treq_in", "usr_carol", "usr_alice");
    await seed(h, "treq_out", "usr_alice", "usr_bob");
    await seed(h, "treq_other", "usr_dan", "usr_eve");

    const inc = (await (await app.request("/task-requests?box=incoming", userInit("GET"))).json()) as task.ListTaskRequestsResponse;
    expect(inc.items.map((r) => r.id)).toEqual(["treq_in"]);
    const out = (await (await app.request("/task-requests?box=outgoing", userInit("GET"))).json()) as task.ListTaskRequestsResponse;
    expect(out.items.map((r) => r.id)).toEqual(["treq_out"]);
  });

  it("400 when box is missing or invalid", async () => {
    const { app } = setup();
    expect((await app.request("/task-requests", userInit("GET"))).status).toBe(400);
    expect((await app.request("/task-requests?box=sideways", userInit("GET"))).status).toBe(400);
  });

  it("filters by state", async () => {
    const { h, app } = setup();
    await seed(h, "treq_p", "usr_bob", "usr_alice");
    await seed(h, "treq_a", "usr_bob", "usr_alice");
    await h.repo.decideRequest("treq_a", { state: "accepted" }, 1, "2026-08-20T01:00:00.000Z");
    const res = (await (await app.request("/task-requests?box=incoming&state=pending", userInit("GET"))).json()) as task.ListTaskRequestsResponse;
    expect(res.items.map((r) => r.id)).toEqual(["treq_p"]);
  });

  it("GET /:id returns the request to a participant, 404 to a stranger, 404 when missing", async () => {
    const { h, app } = setup();
    await seed(h, "treq_x", "usr_alice", "usr_bob");
    await seed(h, "treq_y", "usr_dan", "usr_eve");
    expect((await app.request("/task-requests/treq_x", userInit("GET"))).status).toBe(200);
    const stranger = await app.request("/task-requests/treq_y", userInit("GET"));
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as { error: { code: string } }).error.code).toBe("TASK_REQUEST_NOT_FOUND");
    expect((await app.request("/task-requests/treq_missing", userInit("GET"))).status).toBe(404);
  });
});

// POST /task-requests/:id/accept — receiver materialises both tasks + the cross-link.
describe("POST /task-requests/:id/accept (受け取る)", () => {
  const seedReq = (h: TestHarness, id: string, over: Record<string, unknown> = {}) =>
    h.repo.insertRequest({
      id,
      eventId: "evt_1",
      fromUserId: "usr_alice",
      toUserId: "usr_bob",
      fromTeamId: "team_dev",
      toTeamId: "team_sponsor",
      title: id,
      description: null,
      priority: "medium",
      dueAt: null,
      sourceTaskId: null,
      now: "2026-08-20T00:00:00.000Z",
      ...over,
    });
  const asBob = (body: unknown) => userInit("POST", body, { userId: "usr_bob" });

  it("accepts: creates receiver + requester tasks + cross-link, moves to accepted, emits events", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_1");
    const res = await app.request("/task-requests/treq_1/accept", asBob({ version: 1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as task.AcceptTaskRequestResponse;
    expect(body.request.state).toBe("accepted");
    expect(body.request.createdTaskId).toBe(body.createdTask.id);
    expect(body.createdTask.assigneeId).toBe("usr_bob");
    expect(body.createdTask.teamId).toBe("team_sponsor");
    expect(body.crossLink.requesteeTaskId).toBe(body.createdTask.id);
    // both sides materialised (receiver + auto-generated requester tracking task)
    expect(h.events.byName("task.created")).toHaveLength(2);
    expect(h.events.byName("task.request.accepted")).toHaveLength(1);
    expect(h.events.byName("task.cross_link.created")).toHaveLength(1);
    expect(body.crossLink.requesterTaskId).not.toBe(body.createdTask.id);
  });

  it("reuses sourceTaskId as the requester ('お願いした') task instead of generating one", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_2", { sourceTaskId: "task_src" });
    const res = await app.request("/task-requests/treq_2/accept", asBob({ version: 1 }));
    const body = (await res.json()) as task.AcceptTaskRequestResponse;
    expect(body.crossLink.requesterTaskId).toBe("task_src");
    expect(h.events.byName("task.created")).toHaveLength(1); // only the receiver task
  });

  it("403 when a non-receiver (the requester) tries to accept", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_3");
    const res = await app.request("/task-requests/treq_3/accept", userInit("POST", { version: 1 })); // usr_alice
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_REQUEST_FORBIDDEN_ROLE");
  });

  it("409 when the request is not pending (already accepted)", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_4");
    await app.request("/task-requests/treq_4/accept", asBob({ version: 1 }));
    const again = await app.request("/task-requests/treq_4/accept", asBob({ version: 2 }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("TASK_REQUEST_INVALID_STATE");
  });

  it("409 on a version mismatch", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_5");
    const res = await app.request("/task-requests/treq_5/accept", asBob({ version: 99 }));
    expect(res.status).toBe(409);
  });

  it("404 when the request does not exist", async () => {
    const { app } = setup();
    expect((await app.request("/task-requests/treq_missing/accept", userInit("POST", { version: 1 }, { userId: "usr_bob" }))).status).toBe(404);
  });
});

// POST /task-requests/:id/decline (receiver) + /cancel (requester).
describe("POST /task-requests/:id/decline + /cancel", () => {
  const seedReq = (h: TestHarness, id: string) =>
    h.repo.insertRequest({
      id,
      eventId: "evt_1",
      fromUserId: "usr_alice",
      toUserId: "usr_bob",
      fromTeamId: "team_dev",
      toTeamId: "team_sponsor",
      title: id,
      description: null,
      priority: "medium",
      dueAt: null,
      sourceTaskId: null,
      now: "2026-08-20T00:00:00.000Z",
    });

  it("decline: receiver rejects with a reason, no task/cross-link, emits task.request.declined", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_d");
    const res = await app.request("/task-requests/treq_d/decline", userInit("POST", { version: 1, reason: "多忙" }, { userId: "usr_bob" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as task.TaskRequest;
    expect(body).toMatchObject({ state: "declined", declineReason: "多忙" });
    expect(h.events.byName("task.request.declined")).toHaveLength(1);
    expect(h.events.byName("task.created")).toHaveLength(0);
  });

  it("decline: 403 when a non-receiver tries", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_d2");
    const res = await app.request("/task-requests/treq_d2/decline", userInit("POST", { version: 1 })); // usr_alice
    expect(res.status).toBe(403);
  });

  it("cancel: requester withdraws, emits task.request.cancelled", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_c");
    const res = await app.request("/task-requests/treq_c/cancel", userInit("POST", { version: 1 })); // usr_alice = from
    expect(res.status).toBe(200);
    expect(((await res.json()) as task.TaskRequest).state).toBe("cancelled");
    expect(h.events.byName("task.request.cancelled")).toHaveLength(1);
  });

  it("cancel: 403 when the receiver (not the requester) tries", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_c2");
    const res = await app.request("/task-requests/treq_c2/cancel", userInit("POST", { version: 1 }, { userId: "usr_bob" }));
    expect(res.status).toBe(403);
  });

  it("409 when declining/cancelling a non-pending request", async () => {
    const { h, app } = setup();
    await seedReq(h, "treq_x");
    await app.request("/task-requests/treq_x/cancel", userInit("POST", { version: 1 }));
    const res = await app.request("/task-requests/treq_x/decline", userInit("POST", { version: 2 }, { userId: "usr_bob" }));
    expect(res.status).toBe(409);
  });
});

// GET /tasks/cross-links?eventId= — the event's arrow-less cross-team links.
describe("GET /tasks/cross-links", () => {
  const link = (h: TestHarness, id: string, eventId: string) =>
    h.repo.insertCrossLink({
      id,
      requestId: `treq_${id}`,
      requesterTaskId: `task_r_${id}`,
      requesteeTaskId: `task_e_${id}`,
      eventId,
      now: "2026-08-20T00:00:00.000Z",
    });

  it("returns only the requested event's cross-links (same shape as /dependencies)", async () => {
    const { h, app } = setup();
    await link(h, "txl_1", "evt_1");
    await link(h, "txl_2", "evt_1");
    await link(h, "txl_3", "evt_2");
    const res = await app.request("/tasks/cross-links?eventId=evt_1", userInit("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as task.ListTaskCrossLinksResponse;
    expect(body.items.map((c) => c.id).sort()).toEqual(["txl_1", "txl_2"]);
    expect(body.items[0]).toHaveProperty("requesterTaskId");
    expect(body.items[0]).toHaveProperty("requesteeTaskId");
  });

  it("400 when eventId is absent", async () => {
    const { app } = setup();
    const res = await app.request("/tasks/cross-links", userInit("GET"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("is a literal route — not captured by /tasks/:id", async () => {
    const { app } = setup();
    // A GET without eventId must be the cross-links 400, not a 404 for task id "cross-links".
    const res = await app.request("/tasks/cross-links?eventId=evt_1", userInit("GET"));
    expect(res.status).toBe(200);
  });
});

// D4 (ADR-0007): POST /tasks must not let a cross-team assignee be set directly — that
// bypasses the 送る・受け取る request flow. Guard fires only when team_id is non-null AND
// the assignee's teams are known and exclude it. Teamless / unknown-team pass through.
describe("POST /tasks — cross-team assignee guard (D4)", () => {
  const post = (app: Hono, body: Record<string, unknown>) =>
    app.request("/tasks", userInit("POST", { eventId: "evt_1", title: "T", ...body }));

  it("422 when assigning a team task to someone on another team", async () => {
    const { h, app } = setup();
    h.member.teams.set("usr_bob", ["team_sponsor"]);
    const res = await post(app, { teamId: "team_dev", assigneeId: "usr_bob" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TASK_CROSS_TEAM_ASSIGNEE");
  });

  it("201 when the assignee belongs to the task's team", async () => {
    const { h, app } = setup();
    h.member.teams.set("usr_bob", ["team_dev", "team_x"]);
    const res = await post(app, { teamId: "team_dev", assigneeId: "usr_bob" });
    expect(res.status).toBe(201);
  });

  it("201 (pass-through) for a teamless task even if the assignee is on some other team", async () => {
    const { h, app } = setup();
    h.member.teams.set("usr_bob", ["team_sponsor"]);
    const res = await post(app, { assigneeId: "usr_bob" }); // no teamId
    expect(res.status).toBe(201);
  });

  it("201 (pass-through) when the assignee's teams are unknown (no linked member ⇒ [])", async () => {
    const { app } = setup();
    const res = await post(app, { teamId: "team_dev", assigneeId: "usr_nomember" });
    expect(res.status).toBe(201);
  });
});
