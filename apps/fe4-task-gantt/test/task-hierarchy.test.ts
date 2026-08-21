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

// Scope model (ADR-0007: dependency boundary is the TEAM, not the parent).
//   Team A: P (top) ─┬ c1     R (top)
//                     └ c2
//   Team B: Q (top) ── d1
// Within team A a dependency may cross scopes (parent↔child, top↔top, sibling);
// A↔B is cross-team and rejected.
const ROWS: gantt.GanttRow[] = [
  { taskId: "P", title: "親P", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null, teamId: "A", hasChildren: true },
  { taskId: "R", title: "親R", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null, teamId: "A", hasChildren: false },
  { taskId: "Q", title: "親Q", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: null, teamId: "B", hasChildren: true },
  { taskId: "c1", title: "子1", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: "P", teamId: "A" },
  { taskId: "c2", title: "子2", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: "P", teamId: "A" },
  { taskId: "d1", title: "子D", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null, parentTaskId: "Q", teamId: "B" },
];

describe("task-hierarchy scope rules (ADR-0007: 同一チーム内なら別スコープOK・別チーム不可)", () => {
  const st = scopeTasksFromRows(ROWS);

  it("directParentOf reads the row's direct parent (null = top-level)", () => {
    expect(directParentOf(st, "c1")).toBe("P");
    expect(directParentOf(st, "P")).toBeNull();
  });

  it("sameScope: same team yes (any scope), different team no", () => {
    expect(sameScope(st, "c1", "c2")).toBe(true); // 兄弟(同チーム) OK
    expect(sameScope(st, "c1", "P")).toBe(true); // 親子(同チーム) OK ← 緩和
    expect(sameScope(st, "P", "R")).toBe(true); // トップレベル同士(同チーム) OK
    expect(sameScope(st, "c1", "d1")).toBe(false); // 別チーム NG
    expect(sameScope(st, "P", "Q")).toBe(false); // 別チーム NG
  });

  it("dependencyScopeOptions offers every same-team task across scopes, excluding self", () => {
    // for c1 (team A): P (親), c2 (兄弟), R (別トップレベル) — all team A, but not d1 (team B)
    const forC1 = dependencyScopeOptions(st, "A", "c1").map((o) => o.id).sort();
    expect(forC1).toEqual(["P", "R", "c2"]);
    // for a team-B task, only the other team-B tasks
    const forQ = dependencyScopeOptions(st, "B", "Q").map((o) => o.id);
    expect(forQ).toEqual(["d1"]);
  });

  it("pruneToScope drops ids that are on another team", () => {
    // keep team-A ids, drop team-B d1
    expect(pruneToScope(st, "A", ["c2", "P", "d1"])).toEqual(["c2", "P"]);
  });
});

const mkTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, teamId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

function scopedClient(): MockApiClient {
  return new MockApiClient({
    tasks: [
      mkTask("P", { teamId: "A" }),
      mkTask("R", { teamId: "A" }),
      mkTask("Q", { teamId: "B" }),
      mkTask("c1", { teamId: "A" }),
      mkTask("c2", { teamId: "A" }),
      mkTask("d1", { teamId: "B" }),
    ],
    hierarchy: {
      c1: { parentTaskId: "P", depth: 1 },
      c2: { parentTaskId: "P", depth: 1 },
      d1: { parentTaskId: "Q", depth: 1 },
    },
  });
}

describe("replaceDependencies enforces the same-team rule (ADR-0007)", () => {
  it("allows a dependency between siblings (同チーム)", async () => {
    const c = scopedClient();
    // Response is the wire shape { taskId, dependsOnIds } — NOT a Task with `version`
    // (F1: matches the real task-service; the old mock returned a Task and hid the bug).
    const res = await api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["c2"] });
    expect(res).toEqual({ taskId: "c1", dependsOnIds: ["c2"] });
    expect((res as { version?: number }).version).toBeUndefined();
  });

  it("allows a cross-scope dependency within the same team (親子・別階層 OK)", async () => {
    const c = scopedClient();
    // c1's direct parent P — now a valid predecessor because both are team A.
    const res = await api.replaceDependencies(c, "c1", { version: 1, dependsOnIds: ["P"] });
    expect(res).toEqual({ taskId: "c1", dependsOnIds: ["P"] });
  });

  it("allows a dependency between two top-level tasks on the same team", async () => {
    const c = scopedClient();
    const res = await api.replaceDependencies(c, "P", { version: 1, dependsOnIds: ["R"] });
    expect(res).toEqual({ taskId: "P", dependsOnIds: ["R"] });
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
