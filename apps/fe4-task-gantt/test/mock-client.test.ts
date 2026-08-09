import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { MockApiClient, hasCycle } from "../src/api/mock-client";
import { isApiError, ApiError } from "../src/contracts/spa-shell";
import * as api from "../src/api/endpoints";

const seedTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: `2026-08-0${id.slice(-1)}T00:00:00Z`, updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

describe("MockApiClient contract enforcement (design tests 2/3/9/11/12)", () => {
  it("lists with filters + cursor paging (no dup/gap)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1"), seedTask("t2"), seedTask("t3")] });
    const p1 = await api.listTasks(c, { eventId: "evt_1", limit: 2 });
    expect(p1.items.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(p1.nextCursor).toBe("t2");
    const p2 = await api.listTasks(c, { eventId: "evt_1", limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((t) => t.id)).toEqual(["t3"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("PATCH status success bumps version", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    const updated = await api.updateTask(c, "t1", { version: 1, status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    expect(updated.version).toBe(2);
  });

  it("PATCH with stale version -> 409 TASK_VERSION_CONFLICT", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1", { version: 5 })] });
    await expect(api.updateTask(c, "t1", { version: 1, status: "in_progress" })).rejects.toSatisfy((e: unknown) => {
      return isApiError(e) && e.status === 409 && e.body.error.code === "TASK_VERSION_CONFLICT";
    });
  });

  it("PATCH illegal transition -> 409 TASK_INVALID_STATUS_TRANSITION", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1", { status: "blocked" })] });
    await expect(api.updateTask(c, "t1", { version: 1, status: "done" })).rejects.toSatisfy((e: unknown) => {
      return isApiError(e) && e.body.error.code === "TASK_INVALID_STATUS_TRANSITION";
    });
  });

  it("dependency cycle -> 409 TASK_DEPENDENCY_CYCLE", async () => {
    const c = new MockApiClient({
      tasks: [seedTask("t1"), seedTask("t2")],
      dependencies: [{ id: "t1->t2", fromTaskId: "t1", toTaskId: "t2", type: "FS", lagDays: 0 }],
    });
    // t2 already depends on t1; making t1 depend on t2 closes a cycle
    await expect(api.replaceDependencies(c, "t1", { version: 1, dependsOnIds: ["t2"] })).rejects.toSatisfy((e: unknown) => {
      return isApiError(e) && e.body.error.code === "TASK_DEPENDENCY_CYCLE";
    });
  });

  it("create then get; delete soft-archives", async () => {
    const c = new MockApiClient();
    const created = await api.createTask(c, { eventId: "evt_1", title: "new" });
    expect(created.status).toBe("todo");
    expect((await api.getTask(c, created.id)).title).toBe("new");
    await api.deleteTask(c, created.id);
    const list = await api.listTasks(c, { eventId: "evt_1" });
    expect(list.items.find((t) => t.id === created.id)).toBeUndefined(); // archived hidden
  });

  it("forced failNext surfaces the injected ApiError (error-branch fixture, test 11)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    c.failNext = new ApiError(429, { error: { code: "RATE_LIMITED", message: "slow down", retryable: true } });
    await expect(api.listTasks(c, { eventId: "evt_1" })).rejects.toSatisfy((e: unknown) => {
      return isApiError(e) && e.status === 429 && e.body.error.code === "RATE_LIMITED";
    });
  });
});

describe("hasCycle util", () => {
  it("detects a 2-node cycle", () => {
    expect(hasCycle(new Map([["a", ["b"]], ["b", ["a"]]]))).toBe(true);
  });
  it("passes a DAG", () => {
    expect(hasCycle(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]))).toBe(false);
  });
});
