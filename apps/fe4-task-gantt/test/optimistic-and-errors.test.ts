// PR-A: optimistic create/delete + no-swallow error surfacing + assignee roster.
import { describe, it, expect, beforeEach } from "vitest";
import type { task, identity } from "@dub/types";
import { MockApiClient } from "../src/api/mock-client";
import { useTaskStore } from "../src/store/useTaskStore";
import { getTask, listRosterUsers, replaceDependencies, resolveUsers, updateTask } from "../src/api/endpoints";
import { errorSurface } from "../src/domain/error-mapping";
import { buildProvisionalTask, provisionalGanttRow, provisionalTaskId } from "../src/domain/provisional";
import { ApiError } from "../src/contracts/spa-shell";

// A wire ApiError the mock throws on the next call (drives rollback branches).
function makeApiError(): ApiError {
  return new ApiError(400, {
    error: { code: "TASK_VALIDATION_FAILED", message: "入力内容を確認してください", retryable: false },
  });
}

const seedTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

const roster: identity.UserSummary[] = [
  { id: "usr_a", displayName: "あさひ", avatarUrl: null },
  { id: "usr_b", displayName: "ばんり", avatarUrl: null },
];

beforeEach(() => {
  useTaskStore.setState({ tasks: {}, nextCursor: null, lastError: null, lastErrorDetail: null });
});

describe("optimistic create", () => {
  it("shows the provisional task instantly, then swaps it for the server row", async () => {
    const c = new MockApiClient({});
    const s = useTaskStore.getState();
    const tempId = provisionalTaskId();
    const provisional = buildProvisionalTask(
      tempId,
      { title: "会場確認", status: "todo", priority: "high", assigneeId: "usr_a", teamId: null, startAt: null, dueAt: "2026-09-01T00:00:00.000Z", parentTaskId: null },
      "evt_1",
      "2026-08-17T00:00:00.000Z",
    );
    const p = s.create(c, { eventId: "evt_1", title: "会場確認", priority: "high" }, provisional);
    // instant: provisional visible before the POST resolves
    expect(useTaskStore.getState().tasks[tempId]?.title).toBe("会場確認");
    const created = await p;
    expect(created).not.toBeNull();
    // swapped: provisional gone, real server task present
    expect(useTaskStore.getState().tasks[tempId]).toBeUndefined();
    expect(useTaskStore.getState().list().some((t) => t.title === "会場確認" && t.id !== tempId)).toBe(true);
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it("rolls back the provisional task and surfaces the reason on failure", async () => {
    const c = new MockApiClient({});
    c.failNext = makeApiError();
    const tempId = provisionalTaskId();
    const provisional = buildProvisionalTask(
      tempId,
      { title: "x", status: "todo", priority: "medium", assigneeId: null, teamId: null, startAt: null, dueAt: null, parentTaskId: null },
      "evt_1",
      "2026-08-17T00:00:00.000Z",
    );
    const created = await useTaskStore.getState().create(c, { eventId: "evt_1", title: "x" }, provisional);
    expect(created).toBeNull();
    expect(useTaskStore.getState().tasks[tempId]).toBeUndefined(); // rolled back
    expect(useTaskStore.getState().lastErrorDetail).not.toBeNull(); // reason kept, not swallowed
  });
});

describe("optimistic delete", () => {
  it("removes instantly then confirms", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    await useTaskStore.getState().load(c, { eventId: "evt_1" });
    const p = useTaskStore.getState().removeTask(c, "t1");
    expect(useTaskStore.getState().tasks["t1"]).toBeUndefined(); // gone before round-trip
    expect(await p).toBe(true);
  });

  it("restores the row and surfaces the reason when delete fails", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    await useTaskStore.getState().load(c, { eventId: "evt_1" });
    c.failNext = makeApiError();
    const ok = await useTaskStore.getState().removeTask(c, "t1");
    expect(ok).toBe(false);
    expect(useTaskStore.getState().tasks["t1"]).toBeDefined(); // rolled back
    expect(useTaskStore.getState().lastErrorDetail).not.toBeNull();
  });
});

describe("error surfacing helpers", () => {
  it("reportError/clearError never swallow an out-of-store failure", () => {
    useTaskStore.getState().reportError(makeApiError());
    expect(useTaskStore.getState().lastErrorDetail).not.toBeNull();
    expect(useTaskStore.getState().lastError).not.toBeNull();
    useTaskStore.getState().clearError();
    expect(useTaskStore.getState().lastErrorDetail).toBeNull();
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it("routes auto-recovered errors to a banner and real failures to a dialog", () => {
    expect(errorSurface("rollback_refetch")).toBe("banner");
    expect(errorSurface("toast_retry_backoff")).toBe("banner");
    expect(errorSurface("field_errors")).toBe("dialog");
    expect(errorSurface("dependency_cycle_inline")).toBe("dialog");
    expect(errorSurface("toast_generic")).toBe("dialog");
  });
});

describe("assignee roster (bug 1b)", () => {
  it("lists ALL org members, not only users already assigned to a task", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")], users: roster });
    const out = await listRosterUsers(c);
    expect(out.items.map((u) => u.id).sort()).toEqual(["usr_a", "usr_b"]);
  });

  it("ids-mode resolve still returns only the requested users", async () => {
    const c = new MockApiClient({ users: roster });
    const out = await resolveUsers(c, ["usr_b"]);
    expect(out.items.map((u) => u.id)).toEqual(["usr_b"]);
  });
});

describe("provisional gantt row", () => {
  it("derives a deadline-anchored bar identical to the server derivation", () => {
    const t = seedTask("t1", { priority: "high", dueAt: "2026-09-10T00:00:00.000Z" });
    const row = provisionalGanttRow(t, null);
    expect(row.endsAt).toBe("2026-09-10T00:00:00.000Z");
    // high priority = 2-day bar
    expect(row.startsAt).toBe("2026-09-08T00:00:00.000Z");
  });
});

describe("F3: loadAll pages through the whole event (>200 tasks)", () => {
  it("loads all 216 tasks, not just the first page", async () => {
    const many = Array.from({ length: 216 }, (_, i) => seedTask(`t${String(i).padStart(3, "0")}`));
    const c = new MockApiClient({ tasks: many });
    await useTaskStore.getState().loadAll(c, { eventId: "evt_1", limit: 200 });
    expect(useTaskStore.getState().list()).toHaveLength(216);
    expect(useTaskStore.getState().nextCursor).toBeNull();
  });
});

describe("F1: dependency op returns the wire shape { taskId, dependsOnIds }, not a Task", () => {
  it("carries no version (callers must not read one off it)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1"), seedTask("t2")] });
    const res = await replaceDependencies(c, "t1", { version: 1, dependsOnIds: ["t2"] });
    expect(res).toEqual({ taskId: "t1", dependsOnIds: ["t2"] });
    expect((res as { version?: number }).version).toBeUndefined();
    // the task's version WAS bumped server-side (visible via a fresh read)
    const fresh = await getTask(c, "t1");
    expect(fresh.version).toBe(2);
  });
});

describe("reparent → 先行(依存) save uses the LATEST version (reparent→dep bug)", () => {
  // Repro: A, B(child of A). Detach B (parent→なし, version bumps). Then make B depend
  // on A. A stale (pre-detach) version 409s; re-reading the fresh version registers it.
  const mk = (id: string, over: Partial<task.Task> = {}): task.Task => ({
    id, eventId: "evt_1", title: id, description: null, status: "todo",
    priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
    archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
  });

  it("registers B→A when the deps save re-reads B's fresh version after the detach", async () => {
    const c = new MockApiClient({
      tasks: [mk("A"), mk("B")],
      hierarchy: { B: { parentTaskId: "A", depth: 1 } },
    });
    // step 3: detach B (parent → なし) — bumps B's version 1 → 2
    const before = await getTask(c, "B");
    await updateTask(c, "B", { version: before.version, parentTaskId: null });

    // step 4 with a STALE version (the panel's cached pre-detach version) → 409
    await expect(
      replaceDependencies(c, "B", { version: before.version, dependsOnIds: ["A"] }),
    ).rejects.toSatisfy((e: unknown) => (e as { status?: number }).status === 409);

    // step 4 the way applyRelationsRaw does it — re-read the fresh version first → OK
    const fresh = await getTask(c, "B");
    const res = await replaceDependencies(c, "B", { version: fresh.version, dependsOnIds: ["A"] });
    expect(res).toEqual({ taskId: "B", dependsOnIds: ["A"] });
    // A→B is a valid dependency (no cycle: B is no longer A's child)
    expect(await getTask(c, "B").then((t) => t.version)).toBe(3);
  });
});
