import { describe, it, expect, beforeEach } from "vitest";
import type { task } from "@dub/types";
import { MockApiClient } from "../src/api/mock-client";
import { useTaskStore } from "../src/store/useTaskStore";

const seedTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

describe("useTaskStore optimistic flow against mock (design tests 2/3)", () => {
  beforeEach(() => {
    useTaskStore.setState({ tasks: {}, nextCursor: null, lastError: null });
  });

  it("board move success: optimistic then confirmed with new version", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    const s = useTaskStore.getState();
    await s.load(c, { eventId: "evt_1" });
    const res = await useTaskStore.getState().patchOptimistic(
      c, "t1", { status: "in_progress" }, 1, { version: 1, status: "in_progress" },
    );
    expect(res?.status).toBe("in_progress");
    const t1 = useTaskStore.getState().tasks["t1"]!;
    expect(t1.status).toBe("in_progress");
    expect(t1.version).toBe(2); // confirmed by server
    expect(useTaskStore.getState().lastError).toBeNull();
  });

  it("409 version conflict: card rolls back to original column + error surfaced (test 3)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1", { version: 5 })] });
    await useTaskStore.getState().load(c, { eventId: "evt_1" });
    const res = await useTaskStore.getState().patchOptimistic(
      c, "t1", { status: "in_progress" }, 1, { version: 1, status: "in_progress" }, // stale version
    );
    expect(res).toBeNull();
    expect(useTaskStore.getState().tasks["t1"]!.status).toBe("todo"); // rolled back
    expect(useTaskStore.getState().lastError?.action).toBe("rollback_refetch");
  });

  it("loadMore appends the next page without dropping the first (test 1)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1"), seedTask("t2"), seedTask("t3")] });
    await useTaskStore.getState().load(c, { eventId: "evt_1", limit: 2 });
    expect(useTaskStore.getState().list()).toHaveLength(2);
    expect(useTaskStore.getState().nextCursor).toBe("t2");
    await useTaskStore.getState().loadMore(c, { eventId: "evt_1", limit: 2 });
    expect(useTaskStore.getState().list().map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(useTaskStore.getState().nextCursor).toBeNull();
  });

  it("delete removes from all views' shared store", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    await useTaskStore.getState().load(c, { eventId: "evt_1" });
    expect(await useTaskStore.getState().removeTask(c, "t1")).toBe(true);
    expect(useTaskStore.getState().tasks["t1"]).toBeUndefined();
  });
});
