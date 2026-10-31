// Optimistic-create dependency lines: the 先行タスク(依存) connector arrows must be
// synthesizable the same tick 作成 is hit, so they paint before the deps persist +
// refetch land. These builders are pure — the wiring lives in TaskWorkspacePage.onCreate.
import { describe, it, expect } from "vitest";
import type { common } from "@dub/types";
import { buildProvisionalDeps, isProvisionalId, provisionalTaskId } from "../src/domain/provisional";

const id = (s: string) => s as common.TaskId;

describe("isProvisionalId", () => {
  it("recognises minted temp ids and rejects real ones", () => {
    const temp = provisionalTaskId();
    expect(isProvisionalId(temp)).toBe(true);
    expect(isProvisionalId(id("task_real"))).toBe(false);
    expect(isProvisionalId(id("evt_x"))).toBe(false);
  });
});

describe("buildProvisionalDeps", () => {
  it("draws an incoming edge from each depends-on task into the new task", () => {
    const deps = buildProvisionalDeps(id("task_tmp_new"), [id("t1"), id("t2")], null);
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({ fromTaskId: "t1", toTaskId: "task_tmp_new", type: "FS", lagDays: 0 });
    expect(deps[1]).toMatchObject({ fromTaskId: "t2", toTaskId: "task_tmp_new" });
    // id mirrors the server/read-model convention `${toTaskId}->${fromTaskId}`
    expect(deps[0]!.id).toBe("task_tmp_new->t1");
  });

  it("adds an outgoing edge when the new task is a predecessor of a target (＋先行タスクを作成)", () => {
    const deps = buildProvisionalDeps(id("task_tmp_new"), [], id("t9"));
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ fromTaskId: "task_tmp_new", toTaskId: "t9", id: "t9->task_tmp_new" });
  });

  it("combines depends-on and predecessor-for edges", () => {
    const deps = buildProvisionalDeps(id("task_tmp_new"), [id("t1")], id("t9"));
    expect(deps.map((d) => d.id)).toEqual(["task_tmp_new->t1", "t9->task_tmp_new"]);
  });

  it("never draws a self-edge", () => {
    const self = id("task_tmp_new");
    expect(buildProvisionalDeps(self, [self], self)).toHaveLength(0);
  });
});
