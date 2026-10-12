import { describe, it, expect } from "vitest";
import { bundleBlocker, bundleChildren, bundleLane, withoutBundled } from "./bundles.ts";
import { checkBundleLocally } from "./commanderApi.ts";
import type { StagingBundle } from "./commanderApi.ts";
import { makeBoardItem } from "../test/fakes.ts";

const PR = "https://github.com/o/r/pull/1";

function bundle(over: Partial<StagingBundle> = {}): StagingBundle {
  return { id: "b1", taskIds: ["a", "b"], status: "merging", slot: "staging2", stagingUrl: null, branch: "staging/b1", prUrl: null, runId: null, markers: {}, createdAt: "t", ...over };
}

describe("bundleBlocker", () => {
  it("accepts a demo-approved task with a PR that is not on any staging slot", () => {
    expect(bundleBlocker(makeBoardItem({ featurePhase: "staging_review", runStatus: "succeeded", prUrl: PR }))).toBeNull();
    expect(bundleBlocker(makeBoardItem({ featurePhase: "staging_deployed", runStatus: "succeeded", prUrl: PR }))).toBeNull();
  });

  it("rejects tasks before demo approval, already on staging, without a PR or needing a fix", () => {
    expect(bundleBlocker(makeBoardItem({ featurePhase: "demo_review", runStatus: "succeeded", prUrl: PR }))).toBe("demo 承認前");
    expect(bundleBlocker(makeBoardItem({ featurePhase: "staging_review", runStatus: "succeeded", prUrl: PR, stagingUrl: "https://s" }))).toBe("staging に反映済み");
    expect(bundleBlocker(makeBoardItem({ featurePhase: "staging_review", runStatus: "succeeded" }))).toBe("PR がまだ無い");
    expect(bundleBlocker(makeBoardItem({ featurePhase: "staging_review", runStatus: "failed", prUrl: PR }))).toBe("要修正");
    expect(bundleBlocker(makeBoardItem({ featurePhase: "staging_review", runStatus: "succeeded", prUrl: PR, taskStatus: "done" }))).toBe("アーカイブ済み");
  });
});

describe("bundle placement", () => {
  it("puts a merging bundle in stg反映中 and a deployed or failed one in stg確認待ち", () => {
    expect(bundleLane(bundle({ status: "merging" }))).toBe("staging_deploying");
    expect(bundleLane(bundle({ status: "deployed" }))).toBe("staging_review");
    expect(bundleLane(bundle({ status: "failed" }))).toBe("staging_review");
  });

  it("removes bundled tasks from the lanes and resolves children in bundle order", () => {
    const items = ["a", "b", "c"].map((id) => makeBoardItem({ taskId: id, featureId: `f-${id}` }));
    const b = bundle({ taskIds: ["b", "a", "gone"] });
    expect(withoutBundled(items, [b]).map((i) => i.taskId)).toEqual(["c"]);
    expect(bundleChildren(b, items).map((i) => i.taskId)).toEqual(["b", "a"]);
  });
});

describe("checkBundleLocally", () => {
  it("blocks a task without a PR and two tasks sharing one PR", () => {
    const items = [
      makeBoardItem({ taskId: "a", prUrl: PR }),
      makeBoardItem({ taskId: "b", prUrl: PR }),
      makeBoardItem({ taskId: "c", prUrl: null }),
    ];
    const issues = checkBundleLocally(["a", "b", "c"], items);
    expect(issues.filter((i) => i.block).map((i) => i.taskIds)).toEqual([["c"], ["a", "b"]]);
  });

  it("only notes that conflicts are checked by the run when nothing blocks", () => {
    const items = [makeBoardItem({ taskId: "a", prUrl: PR }), makeBoardItem({ taskId: "b", prUrl: `${PR}0` })];
    const issues = checkBundleLocally(["a", "b"], items);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.block).toBe(false);
  });
});
