import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import {
  indexTasks,
  applyOptimistic,
  rollback,
  confirm,
  remove,
  byStatus,
} from "../src/domain/task-store";

const mk = (id: string, status: task.TaskStatus, version = 1): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status,
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version,
});

describe("task-store reducer (design test 2/3/5/9)", () => {
  it("applyOptimistic mutates status and yields a rollback snapshot", () => {
    const map = indexTasks([mk("t1", "todo")]);
    const [next, snap] = applyOptimistic(map, { id: "t1", changes: { status: "in_progress" } });
    expect(next["t1"]!.status).toBe("in_progress");
    expect(snap.previous!.status).toBe("todo");
    // optimistic edit does not bump version (server owns it)
    expect(next["t1"]!.version).toBe(1);
  });

  it("rollback restores the pre-optimistic entry (409 path)", () => {
    const map = indexTasks([mk("t1", "todo")]);
    const [next, snap] = applyOptimistic(map, { id: "t1", changes: { status: "done" } });
    const restored = rollback(next, snap);
    expect(restored["t1"]!.status).toBe("todo");
  });

  it("confirm replaces with the authoritative server task (new version)", () => {
    const map = indexTasks([mk("t1", "todo", 1)]);
    const server = mk("t1", "in_progress", 2);
    expect(confirm(map, server)["t1"]!.version).toBe(2);
  });

  it("rollback of a created-then-failed task removes it", () => {
    const map = indexTasks([]);
    const [next, snap] = applyOptimistic(map, { id: "ghost", changes: { status: "done" } });
    // unknown id => unchanged, snapshot.previous null
    expect(snap.previous).toBeNull();
    expect(rollback(next, snap)["ghost"]).toBeUndefined();
  });

  it("byStatus partitions for the board", () => {
    const map = indexTasks([mk("a", "todo"), mk("b", "todo"), mk("c", "done")]);
    expect(byStatus(map, "todo").map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(remove(map, "c")["c"]).toBeUndefined();
  });
});
