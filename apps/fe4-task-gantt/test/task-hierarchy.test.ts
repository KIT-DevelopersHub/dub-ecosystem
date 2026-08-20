import { describe, it, expect } from "vitest";
import type { gantt, task } from "@dub/types";
import {
  scopeTasksFromRows,
  directParentOf,
  sameScope,
  dependencyScopeOptions,
  pruneToScope,
} from "../src/domain/task-hierarchy";
import { MockApiClient } from "../src/api/mock-client";
import { isApiError } from "../src/contracts/spa-shell";
import * as api from "../src/api/endpoints";

// Scope model (ADR-0006: dependency boundary = TEAM, spans WBS scopes freely).
//   team_dev:  P ├ c1 ├ c2 , X (top-level, different scope)
//   team_ops:  Q └ d1
const ROWS: gantt.GanttRow[] = [
  { taskId: "P", title: "親P", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, teamId: "team_dev", parentTaskId: null, hasChildren: true },
  { taskId: "Q", title: "親Q", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, teamId: "team_ops", parentTaskId: null, hasChildren: true },
  { taskId: "c1", title: "子1", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, teamId: "team_dev", parentTaskId: "P" },
  { taskId: "c2", title: "子2", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, teamId: "team_dev", parentTaskId: "P" },
  { taskId: "d1", title: "子D", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, teamId: "team_ops", parentTaskId: "Q" },
  { taskId: "X", title: "別X", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, teamId: "team_dev", parentTaskId: null },
];

describe("task-hierarchy scope rules (ADR-0006: 同一チーム内なら別スコープも依存可)", () => {
  const st = scopeTasksFromRows(ROWS);

  it("directParentOf reads the row's direct parent (null = top-level)", () => {
    expect(directParentOf(st, "c1")).toBe("P");
    expect(directParentOf(st, "P")).toBeNull();
  });

  it("sameScope is now team-based: same team yes (any level), cross-team no", () => {
    expect(sameScope(st, "c1", "c2")).toBe(true); // 兄弟(同チーム) OK
    expect(sameScope(st, "c1", "P")).toBe(true); // 親子(同チーム) OK — 判断10から緩和
    expect(sameScope(st, "c1", "X")).toBe(true); // 別スコープ/別階層(同チーム) OK — 今回の主眼
    expect(sameScope(st, "c1", "d1")).toBe(false); // 別チーム NG
    expect(sameScope(st, "P", "Q")).toBe(false); // 別チーム NG
  });

  it("dependencyScopeOptions offers all same-team tasks across scopes, excluding self", () => {
    // for c1 (team_dev): every other team_dev task — P (parent), c2 (sibling), X (other scope)
    const forC1 = dependencyScopeOptions(st, "team_dev", "c1").map((o) => o.id).sort();
    expect(forC1).toEqual(["P", "X", "c2"]);
    // team_ops sees only its own tasks
    const forOps = dependencyScopeOptions(st, "team_ops", "d1").map((o) => o.id);
    expect(forOps).toEqual(["Q"]);
  });

  it("pruneToScope drops ids that belong to another team", () => {
    // for a team_dev task: c2/X kept (team_dev), d1 dropped (team_ops)
    expect(pruneToScope(st, "team_dev", ["c2", "X", "d1"])).toEqual(["c2", "X"]);
  });

  it("null team is its own bucket (back-compat): only other null-team tasks are offered", () => {
    const nullSt = scopeTasksFromRows([
      { taskId: "n1", title: "n1", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null },
      { taskId: "n2", title: "n2", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null },
    ]);
    expect(dependencyScopeOptions(nullSt, null, "n1").map((o) => o.id)).toEqual(["n2"]);
  });
});

const mkTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

// team_dev: P ├ c1 ├ c2 , X(top) ;  team_ops: Q └ d1
function scopedClient(): MockApiClient {
  return new MockApiClient({
    tasks: [
      mkTask("P", { teamId: "team_dev" }),
      mkTask("Q", { teamId: "team_ops" }),
      mkTask("c1", { teamId: "team_dev" }),
      mkTask("c2", { teamId: "team_dev" }),
      mkTask("d1", { teamId: "team_ops" }),
      mkTask("X", { teamId: "team_dev" }),
    ],
    hierarchy: {
      c1: { parentTaskId: "P", depth: 1 },
      c2: { parentTaskId: "P", depth: 1 },
      d1: { parentTaskId: "Q", depth: 1 },
    },
  });
}

describe("replaceDependencies enforces the same-team rule (ADR-0006)", () => {
  it("allows a dependency between siblings of the same team", async () => {
    const c = scopedClient();
    // Response is the wire shape { taskId, dependsOnIds } — NOT a Task with `version`
    // (F1: matches the real task-service; the old mock returned a Task and hid the bug).
    const res = await api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["c2"] });
    expect(res).toEqual({ taskId: "c1", dependsOnIds: ["c2"] });
    expect((res as { version?: number }).version).toBeUndefined();
  });

  it("allows a same-team parent↔child dependency (判断10から緩和)", async () => {
    const c = scopedClient();
    // c1 (team_dev, child of P) depends on P (team_dev) — same team, so now allowed.
    const res = await api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["P"] });
    expect(res).toEqual({ taskId: "c1", dependsOnIds: ["P"] });
  });

  it("allows a same-team dependency across DIFFERENT scopes (別スコープ/別階層 OK)", async () => {
    const c = scopedClient();
    // c1 is nested under P; X is top-level — different scope, same team_dev.
    const res = await api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["X"] });
    expect(res).toEqual({ taskId: "c1", dependsOnIds: ["X"] });
  });

  it("rejects a cross-team dependency (別チーム NG)", async () => {
    const c = scopedClient();
    await expect(api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["d1"] })).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && e.status === 409 && e.body.error.code === "TASK_DEPENDENCY_SCOPE",
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
