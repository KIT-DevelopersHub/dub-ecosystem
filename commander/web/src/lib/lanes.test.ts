import { describe, it, expect } from "vitest";
import {
  deriveLane,
  groupByLane,
  isArchived,
  isReviewLane,
  isRunningLane,
  LANES,
  needsFix,
  type Lane,
} from "./lanes.ts";
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
    prUrls: [],
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

  it("running run は段ごとの〜中列: 実装中 / stg反映中 / 本番反映中", () => {
    expect(deriveLane(item({ run: "pending" }))).toBe<Lane>("implementing");
    expect(deriveLane(item({ run: "running" }))).toBe<Lane>("implementing");
    expect(deriveLane(item({ phase: "staging_deployed", run: "running" }))).toBe<Lane>(
      "staging_deploying",
    );
    expect(deriveLane(item({ phase: "staging_review", run: "pending" }))).toBe<Lane>(
      "staging_deploying",
    );
    expect(deriveLane(item({ phase: "prod_shipped", run: "running" }))).toBe<Lane>("prod_deploying");
  });

  it("settled run は段ごとの確認列: 確認待ち / stg確認待ち / 本番確認中", () => {
    expect(deriveLane(item({ run: "succeeded", phase: "demo_building" }))).toBe<Lane>("review");
    expect(deriveLane(item({ run: "succeeded", phase: "demo_review" }))).toBe<Lane>("review");
    expect(deriveLane(item({ run: "succeeded", phase: "staging_deployed" }))).toBe<Lane>(
      "staging_review",
    );
    expect(deriveLane(item({ run: "succeeded", phase: "staging_review" }))).toBe<Lane>(
      "staging_review",
    );
    expect(deriveLane(item({ run: "succeeded", phase: "prod_shipped" }))).toBe<Lane>("prod_review");
    expect(deriveLane(item({ run: null, phase: "prod_shipped" }))).toBe<Lane>("prod_review");
  });

  it("失敗・却下はその段の確認列に置き needsFix で示す", () => {
    const demoFail = item({ run: "failed" });
    expect(deriveLane(demoFail)).toBe<Lane>("review");
    expect(needsFix(demoFail)).toBe(true);
    const demoRej = item({ phase: "demo_rejected", run: "succeeded" });
    expect(deriveLane(demoRej)).toBe<Lane>("review");
    expect(needsFix(demoRej)).toBe(true);
    const stgFail = item({ phase: "staging_deployed", run: "failed" });
    expect(deriveLane(stgFail)).toBe<Lane>("staging_review");
    expect(needsFix(stgFail)).toBe(true);
    expect(deriveLane(item({ phase: "staging_rejected", run: "succeeded" }))).toBe<Lane>(
      "staging_review",
    );
    const prodFail = item({ phase: "prod_shipped", run: "failed" });
    expect(deriveLane(prodFail)).toBe<Lane>("prod_review");
    expect(needsFix(prodFail)).toBe(true);
    expect(needsFix(item({ phase: "demo_review", run: "succeeded" }))).toBe(false);
  });

  it("本番確認中(生きている)とアーカイブ済(完了)を分ける", () => {
    const shipped = item({ phase: "prod_shipped", run: "succeeded" });
    expect(deriveLane(shipped)).toBe<Lane>("prod_review");
    expect(isArchived(shipped)).toBe(false);
    const archived = item({ phase: "prod_shipped", taskStatus: "done", run: "succeeded" });
    expect(deriveLane(archived)).toBe<Lane>("done");
    expect(isArchived(archived)).toBe(true);
  });

  it("archived task → done even while a run is in flight or failed", () => {
    expect(deriveLane(item({ phase: "prod_shipped", taskStatus: "done", run: "running" }))).toBe<Lane>(
      "done",
    );
    const archivedFail = item({ taskStatus: "done", run: "failed" });
    expect(deriveLane(archivedFail)).toBe<Lane>("done");
    expect(needsFix(archivedFail)).toBe(false);
  });
});

describe("lane groups", () => {
  it("running / review lanes", () => {
    expect(["implementing", "staging_deploying", "prod_deploying"].every((l) => isRunningLane(l as Lane))).toBe(true);
    expect(["review", "staging_review", "prod_review"].every((l) => isReviewLane(l as Lane))).toBe(true);
    expect(isRunningLane("queued")).toBe(false);
    expect(isReviewLane("done")).toBe(false);
  });
});

describe("groupByLane", () => {
  it("buckets items and preserves order within a lane", () => {
    const a = item({ taskId: "a", run: "running" });
    const b = item({ taskId: "b", run: "running" });
    const c = item({ taskId: "c", run: null });
    const grouped = groupByLane([a, b, c]);
    expect(Object.keys(grouped)).toHaveLength(LANES.length);
    expect(grouped.implementing.map((i) => i.taskId)).toEqual(["a", "b"]);
    expect(grouped.queued.map((i) => i.taskId)).toEqual(["c"]);
    expect(grouped.review).toEqual([]);
  });
});
