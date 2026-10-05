import { describe, it, expect } from "vitest";
import { deriveLane, groupByLane, isArchived, type Lane } from "./lanes.ts";
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

  it("prod_shipped shows本番反映の進行: running→running(本番反映中), failed→needs_fix, else→shipped", () => {
    // 本番承認も staging と同じ進行UIに繋ぐ: 反映 run が走行中なら完了へ飛ばさず走行中に見せる。
    expect(deriveLane(item({ phase: "prod_shipped", run: "running" }))).toBe<Lane>("running");
    expect(deriveLane(item({ phase: "prod_shipped", run: "pending" }))).toBe<Lane>("running");
    expect(deriveLane(item({ phase: "prod_shipped", run: "failed" }))).toBe<Lane>("needs_fix");
    expect(deriveLane(item({ phase: "prod_shipped", run: "succeeded" }))).toBe<Lane>("shipped");
    expect(deriveLane(item({ phase: "prod_shipped", run: null }))).toBe<Lane>("shipped");
  });

  it("本番反映済(生きている)とアーカイブ済(完了)を分ける", () => {
    // 完了レーンに入るのは taskStatus=done だけ。prod_shipped は 本番反映済 に留まり、
    // 追加指示を出せる状態のまま残る（勝手に完了させない）。
    const shipped = item({ phase: "prod_shipped", run: "succeeded" });
    expect(deriveLane(shipped)).toBe<Lane>("shipped");
    expect(isArchived(shipped)).toBe(false);
    const archived = item({ phase: "prod_shipped", taskStatus: "done", run: "succeeded" });
    expect(deriveLane(archived)).toBe<Lane>("done");
    expect(isArchived(archived)).toBe(true);
  });

  it("archived prod task (taskStatus done) → done even while a run is in flight", () => {
    expect(deriveLane(item({ phase: "prod_shipped", taskStatus: "done", run: "running" }))).toBe<Lane>(
      "done",
    );
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
