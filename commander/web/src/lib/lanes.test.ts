import { describe, it, expect } from "vitest";
import { deriveLane, groupByLane, type Lane } from "./lanes.ts";
import type { BoardItem, FeaturePhase, RunStatus } from "./commanderApi.ts";

function item(
  over: Partial<BoardItem> & { phase?: FeaturePhase; run?: RunStatus | null },
): BoardItem {
  const { phase, run, ...rest } = over;
  const base: BoardItem = {
    taskId: "t1",
    featureId: "f1",
    title: "task",
    featurePhase: phase ?? "demo_building",
    taskStatus: "todo",
    demoUrl: null,
    stagingUrl: null,
    prUrl: null,
    latestRun:
      run === null || run === undefined
        ? run === null
          ? null
          : { id: "r1", status: "running", cwd: "/repo", createdAt: "t" }
        : { id: "r1", status: run, cwd: "/repo", createdAt: "t" },
    createdAt: "t",
    updatedAt: "t",
  };
  return { ...base, ...rest };
}

describe("deriveLane", () => {
  it("no run yet → queued", () => {
    expect(deriveLane(item({ run: null }))).toBe<Lane>("queued");
  });

  it("pending/running run → running", () => {
    expect(deriveLane(item({ run: "pending" }))).toBe<Lane>("running");
    expect(deriveLane(item({ run: "running" }))).toBe<Lane>("running");
  });

  it("succeeded run → review (awaiting operator judgment)", () => {
    expect(deriveLane(item({ run: "succeeded", phase: "demo_building" }))).toBe<Lane>("review");
    expect(deriveLane(item({ run: "succeeded", phase: "demo_review" }))).toBe<Lane>("review");
  });

  it("failed run → needs_fix", () => {
    expect(deriveLane(item({ run: "failed" }))).toBe<Lane>("needs_fix");
  });

  it("rejected phase → needs_fix even if the last run succeeded", () => {
    expect(deriveLane(item({ phase: "demo_rejected", run: "succeeded" }))).toBe<Lane>("needs_fix");
    expect(deriveLane(item({ phase: "staging_rejected", run: "succeeded" }))).toBe<Lane>("needs_fix");
  });

  it("prod_shipped → done (terminal wins over run status)", () => {
    expect(deriveLane(item({ phase: "prod_shipped", run: "running" }))).toBe<Lane>("done");
  });

  it("archived task (taskStatus done) → done", () => {
    expect(deriveLane(item({ taskStatus: "done", run: "succeeded" }))).toBe<Lane>("done");
  });
});

describe("groupByLane", () => {
  it("buckets items and preserves order within a lane", () => {
    const a = item({ taskId: "a", run: "running" });
    const b = item({ taskId: "b", run: "running" });
    const c = item({ taskId: "c", run: null });
    const grouped = groupByLane([a, b, c]);
    expect(grouped.running.map((i) => i.taskId)).toEqual(["a", "b"]);
    expect(grouped.queued.map((i) => i.taskId)).toEqual(["c"]);
    expect(grouped.review).toEqual([]);
  });
});
