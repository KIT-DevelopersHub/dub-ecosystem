import { describe, it, expect } from "vitest";
import type { gantt, task } from "@dub/types";
import {
  scopeTasksFromRows,
  directParentOf,
  sameScope,
  dependencyScopeOptions,
  topLevelParentOptions,
  pruneToScope,
} from "../src/domain/task-hierarchy";
import { MockApiClient } from "../src/api/mock-client";
import { isApiError } from "../src/contracts/spa-shell";
import * as api from "../src/api/endpoints";

// Scope model: P and Q are top-level parents; c1,c2 are P's children; d1 is Q's.
//   P (null)   Q (null)
//   ├ c1        └ d1
//   └ c2
const ROWS: gantt.GanttRow[] = [
  { taskId: "P", title: "親P", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null, hasChildren: true },
  { taskId: "Q", title: "親Q", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null, hasChildren: true },
  { taskId: "c1", title: "子1", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: "P" },
  { taskId: "c2", title: "子2", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: "P" },
  { taskId: "d1", title: "子D", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: "Q" },
];

describe("task-hierarchy scope rules (判断10: 同一直接親のみ依存可)", () => {
  const st = scopeTasksFromRows(ROWS);

  it("directParentOf reads the row's direct parent (null = top-level)", () => {
    expect(directParentOf(st, "c1")).toBe("P");
    expect(directParentOf(st, "P")).toBeNull();
  });

  it("sameScope: siblings yes, parent-child no, cross-scope no, top-level parents yes", () => {
    expect(sameScope(st, "c1", "c2")).toBe(true); // 兄弟 OK
    expect(sameScope(st, "c1", "P")).toBe(false); // 親子 NG
    expect(sameScope(st, "c1", "d1")).toBe(false); // スコープまたぎ NG
    expect(sameScope(st, "P", "Q")).toBe(true); // 親同士(トップレベル) OK
  });

  it("dependencyScopeOptions offers only same-parent siblings, excluding self", () => {
    // for a task under P (e.g. c1), only c2 is offered — not P (parent) nor d1 (other scope)
    const forC1 = dependencyScopeOptions(st, "P", "c1").map((o) => o.id);
    expect(forC1).toEqual(["c2"]);
    // for a top-level task, only the other top-level tasks
    const forTop = dependencyScopeOptions(st, null, "P").map((o) => o.id);
    expect(forTop).toEqual(["Q"]);
  });

  it("topLevelParentOptions offers only top-level roots (nested descendants excluded)", () => {
    // only P and Q are roots; children c1/c2/d1 are never offered as parents
    expect(topLevelParentOptions(st).map((o) => o.id)).toEqual(["P", "Q"]);
    // the edited task itself is excluded (self/cycle guard)
    expect(topLevelParentOptions(st, "P").map((o) => o.id)).toEqual(["Q"]);
  });

  it("pruneToScope drops ids that are not in the target scope", () => {
    // moving c1 under Q: its old sibling c2 is no longer in-scope and is dropped
    expect(pruneToScope(st, "Q", ["c2", "d1"])).toEqual(["d1"]);
  });
});

const mkTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

function scopedClient(): MockApiClient {
  return new MockApiClient({
    tasks: [mkTask("P"), mkTask("Q"), mkTask("c1"), mkTask("c2"), mkTask("d1")],
    hierarchy: {
      c1: { parentTaskId: "P", depth: 1 },
      c2: { parentTaskId: "P", depth: 1 },
      d1: { parentTaskId: "Q", depth: 1 },
    },
  });
}

describe("replaceDependencies enforces the same-scope rule (判断10)", () => {
  it("allows a dependency between siblings (同じ直接親)", async () => {
    const c = scopedClient();
    // Response is the wire shape { taskId, dependsOnIds } — NOT a Task with `version`
    // (F1: matches the real task-service; the old mock returned a Task and hid the bug).
    const res = await api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["c2"] });
    expect(res).toEqual({ taskId: "c1", dependsOnIds: ["c2"] });
    expect((res as { version?: number }).version).toBeUndefined();
  });

  it("allows a dependency between two top-level parents (親同士)", async () => {
    const c = scopedClient();
    const res = await api.replaceDependencies(c, "P", { version: 1, dependsOnIds: ["Q"] });
    expect(res).toEqual({ taskId: "P", dependsOnIds: ["Q"] });
  });

  it("rejects a parent↔child dependency (親子間 NG)", async () => {
    const c = scopedClient();
    await expect(api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["P"] })).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && e.status === 409 && e.body.error.code === "TASK_DEPENDENCY_SCOPE",
    );
  });

  it("rejects a cross-scope dependency (スコープまたぎ NG)", async () => {
    const c = scopedClient();
    await expect(api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["d1"] })).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && e.body.error.code === "TASK_DEPENDENCY_SCOPE",
    );
  });
});

describe("createTask / updateTask carry the WBS parent onto the gantt rows", () => {
  it("createTask with parentTaskId hangs the new row under that parent", async () => {
    const c = new MockApiClient({ tasks: [mkTask("P")] });
    const child = await api.createTask(c, { eventId: "evt_1", title: "新子", parentTaskId: "P" });
    const dto = await api.getGantt(c, "evt_1");
    const childRow = dto.rows.find((r) => r.taskId === child.id)!;
    expect(childRow.parentTaskId).toBe("P");
    // P now reports it has children (renders a toggle)
    expect(dto.rows.find((r) => r.taskId === "P")!.hasChildren).toBe(true);
  });

  it("updateTask re-parents a row, and null detaches it to top-level", async () => {
    const c = scopedClient();
    // move c1 from P to Q
    await api.updateTask(c, "c1", { version: 1, parentTaskId: "Q" });
    let dto = await api.getGantt(c, "evt_1");
    expect(dto.rows.find((r) => r.taskId === "c1")!.parentTaskId).toBe("Q");
    // detach to top-level
    await api.updateTask(c, "c1", { version: 2, parentTaskId: null });
    dto = await api.getGantt(c, "evt_1");
    expect(dto.rows.find((r) => r.taskId === "c1")!.parentTaskId ?? null).toBeNull();
  });
});
