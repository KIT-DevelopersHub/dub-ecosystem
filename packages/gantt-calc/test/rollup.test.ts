import { describe, it, expect } from "vitest";
import type { ganttCalc } from "@dub/types";
import { computeRollup } from "../src/index";

const t = (
  id: string,
  durationDays: number,
  startsAt: string | null = null,
  endsAt: string | null = null,
): ganttCalc.GanttCalcTask => ({ id, startsAt, endsAt, durationDays });
const dep = (taskId: string, dependsOnId: string): ganttCalc.GanttCalcDependency => ({ taskId, dependsOnId });

describe("computeRollup", () => {
  it("anchors an unconstrained chain at epoch and rolls ES/LF forward", () => {
    const res = computeRollup({
      tasks: [t("task_a", 2), t("task_b", 3)],
      dependencies: [dep("task_b", "task_a")], // b depends on a
    });
    // a: ES day0 -> EF day2 ; b: ES day2 -> EF day5
    expect(res.earliestStart["task_a"]).toBe("1970-01-01T00:00:00.000Z");
    expect(res.earliestStart["task_b"]).toBe("1970-01-03T00:00:00.000Z"); // day2
    // both on the only path -> latestFinish == earliestFinish
    expect(res.latestFinish["task_a"]).toBe("1970-01-03T00:00:00.000Z"); // day2
    expect(res.latestFinish["task_b"]).toBe("1970-01-06T00:00:00.000Z"); // day5
  });

  it("honours explicit startsAt as the anchor and a per-task constraint", () => {
    const res = computeRollup({
      tasks: [t("task_a", 1, "2026-08-10T00:00:00Z"), t("task_b", 1)],
      dependencies: [dep("task_b", "task_a")],
    });
    expect(res.earliestStart["task_a"]).toBe("2026-08-10T00:00:00.000Z");
    expect(res.earliestStart["task_b"]).toBe("2026-08-11T00:00:00.000Z");
  });

  it("gives a parallel branch slack (latestFinish later than earliestFinish)", () => {
    // a -> b(long) , a -> c(short) , b&c -> d
    const res = computeRollup({
      tasks: [t("task_a", 1), t("task_b", 5), t("task_c", 1), t("task_d", 1)],
      dependencies: [dep("task_b", "task_a"), dep("task_c", "task_a"), dep("task_d", "task_b"), dep("task_d", "task_c")],
    });
    // c is on the slack branch: ES day1, EF day2, but LF pushed to day6 (=b's EF)
    expect(res.earliestStart["task_c"]).toBe("1970-01-02T00:00:00.000Z"); // day1
    expect(res.latestFinish["task_c"]).toBe("1970-01-07T00:00:00.000Z"); // day6
  });

  it("returns empty records for an empty task set", () => {
    expect(computeRollup({ tasks: [], dependencies: [] })).toEqual({ earliestStart: {}, latestFinish: {} });
  });

  it("is deterministic under input reordering", () => {
    const tasks = [t("task_a", 2), t("task_b", 3), t("task_c", 1)];
    const deps = [dep("task_b", "task_a"), dep("task_c", "task_b")];
    const a = computeRollup({ tasks, dependencies: deps });
    const b = computeRollup({ tasks: [...tasks].reverse(), dependencies: [...deps].reverse() });
    expect(a).toEqual(b);
  });
});
