import { describe, it, expect } from "vitest";
import type { ganttCalc } from "@dub/types";
import {
  computeCriticalPath,
  GANTT_CALC_DEPENDENCY_CYCLE,
  GANTT_CALC_UNKNOWN_TASK_REF,
} from "../src/index";
import { isDubError } from "@dub/errors";

const t = (id: string, durationDays: number, startsAt: string | null = null): ganttCalc.GanttCalcTask => ({
  id,
  startsAt,
  endsAt: null,
  durationDays,
});
const dep = (taskId: string, dependsOnId: string): ganttCalc.GanttCalcDependency => ({ taskId, dependsOnId });

describe("computeCriticalPath", () => {
  it("finds the longest path through a serial+parallel graph", () => {
    // a(1) -> b(5) -> d(1) is the critical chain; c(1) is a slack branch of a->d
    const res = computeCriticalPath({
      tasks: [t("task_a", 1), t("task_b", 5), t("task_c", 1), t("task_d", 1)],
      dependencies: [dep("task_b", "task_a"), dep("task_c", "task_a"), dep("task_d", "task_b"), dep("task_d", "task_c")],
    });
    expect(res.criticalTaskIds).toEqual(["task_a", "task_b", "task_d"]);
    expect(res.totalDurationDays).toBe(7); // 1 + 5 + 1
  });

  it("marks the slack branch as non-critical", () => {
    const res = computeCriticalPath({
      tasks: [t("task_a", 1), t("task_b", 5), t("task_c", 1), t("task_d", 1)],
      dependencies: [dep("task_b", "task_a"), dep("task_c", "task_a"), dep("task_d", "task_b"), dep("task_d", "task_c")],
    });
    expect(res.criticalTaskIds).not.toContain("task_c");
  });

  it("treats a dependency-free set as all-critical (each its own path)", () => {
    const res = computeCriticalPath({ tasks: [t("task_a", 3), t("task_b", 2)], dependencies: [] });
    expect(res.criticalTaskIds).toContain("task_a"); // longest determines project end
    expect(res.totalDurationDays).toBe(3);
  });

  it("throws GANTT_CALC_DEPENDENCY_CYCLE on a cycle", () => {
    try {
      computeCriticalPath({
        tasks: [t("task_a", 1), t("task_b", 1), t("task_c", 1)],
        dependencies: [dep("task_b", "task_a"), dep("task_c", "task_b"), dep("task_a", "task_c")],
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isDubError(e)).toBe(true);
      if (isDubError(e)) {
        expect(e.code).toBe(GANTT_CALC_DEPENDENCY_CYCLE);
        expect(e.status).toBe(422);
      }
    }
  });

  it("throws GANTT_CALC_UNKNOWN_TASK_REF when a dependency points outside the set", () => {
    try {
      computeCriticalPath({ tasks: [t("task_a", 1)], dependencies: [dep("task_a", "task_ghost")] });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isDubError(e) && e.code).toBe(GANTT_CALC_UNKNOWN_TASK_REF);
    }
  });

  it("empty input -> empty path, zero duration", () => {
    expect(computeCriticalPath({ tasks: [], dependencies: [] })).toEqual({ criticalTaskIds: [], totalDurationDays: 0 });
  });
});
