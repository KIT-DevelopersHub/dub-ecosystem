import { describe, it, expect } from "vitest";
import { reflectionOf, reflectionLabel, DUB_STAGING_URL } from "./reflection.ts";
import type { BoardItem, FeaturePhase, RunStatus } from "./commanderApi.ts";

function item(
  over: Partial<BoardItem> & { phase?: FeaturePhase; run?: RunStatus | null },
): BoardItem {
  const { phase, run, ...rest } = over;
  return {
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
        ? null
        : { id: "r1", status: run, cwd: "/repo", createdAt: "t" },
    createdAt: "t",
    updatedAt: "t",
    ...rest,
  };
}

describe("reflectionOf", () => {
  it("queued (demo_building, no run) → null", () => {
    expect(reflectionOf(item({ phase: "demo_building", run: null }))).toBeNull();
  });

  it("staging_review + succeeded run → stagingに反映済み with the staging URL", () => {
    const r = reflectionOf(
      item({ phase: "staging_review", run: "succeeded", stagingUrl: "https://stg.example" }),
    );
    expect(r).toEqual({ state: "reflected", env: "staging", url: "https://stg.example" });
    expect(reflectionLabel(r!)).toBe("stagingに反映済み");
  });

  it("staging_review with no captured staging URL → falls back to the fixed staging host", () => {
    // Regression: badge said 「stagingに反映済み」 but the click-through URL was empty/demo.
    const r = reflectionOf(item({ phase: "staging_review", run: "succeeded", stagingUrl: null }));
    expect(r).toEqual({ state: "reflected", env: "staging", url: DUB_STAGING_URL });
  });

  it("staging_deployed + running run → stagingに反映中 (in flight)", () => {
    const r = reflectionOf(item({ phase: "staging_deployed", run: "running" }));
    expect(r?.state).toBe("reflecting");
    expect(r?.env).toBe("staging");
    expect(reflectionLabel(r!)).toBe("stagingに反映中");
  });

  it("staging_deployed + failed run → staging反映失敗", () => {
    const r = reflectionOf(item({ phase: "staging_deployed", run: "failed" }));
    expect(r?.state).toBe("failed");
    expect(reflectionLabel(r!)).toBe("staging反映失敗");
  });

  it("staging_rejected → staging反映失敗 regardless of run", () => {
    expect(reflectionOf(item({ phase: "staging_rejected", run: "succeeded" }))?.state).toBe("failed");
  });

  it("prod_shipped tracks本番反映: running→反映中, failed→失敗, succeeded→反映済み", () => {
    expect(reflectionOf(item({ phase: "prod_shipped", run: "running" }))).toMatchObject({
      state: "reflecting",
      env: "prod",
    });
    expect(reflectionOf(item({ phase: "prod_shipped", run: "failed" }))).toMatchObject({
      state: "failed",
      env: "prod",
    });
    const shipped = reflectionOf(item({ phase: "prod_shipped", run: "succeeded" }));
    expect(shipped?.state).toBe("reflected");
    expect(reflectionLabel(shipped!)).toBe("本番に反映済み");
  });

  it("demo_review + succeeded → demoに反映済み with the demo URL", () => {
    const r = reflectionOf(item({ phase: "demo_review", run: "succeeded", demoUrl: "https://demo.example" }));
    expect(r).toEqual({ state: "reflected", env: "demo", url: "https://demo.example" });
  });
});
