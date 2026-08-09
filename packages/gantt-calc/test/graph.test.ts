import { describe, it, expect } from "vitest";
import type { ganttCalc } from "@dub/types";
import { topologicalSort, validateDependencies, GANTT_CALC_DEPENDENCY_CYCLE } from "../src/index";
import { isDubError } from "@dub/errors";

const dep = (taskId: string, dependsOnId: string): ganttCalc.GanttCalcDependency => ({ taskId, dependsOnId });

describe("topologicalSort", () => {
  it("orders predecessors before successors, ties by id asc", () => {
    const order = topologicalSort(["task_c", "task_a", "task_b"], [dep("task_b", "task_a"), dep("task_c", "task_b")]);
    expect(order).toEqual(["task_a", "task_b", "task_c"]);
  });

  it("is deterministic for independent nodes (id asc)", () => {
    expect(topologicalSort(["task_c", "task_a", "task_b"], [])).toEqual(["task_a", "task_b", "task_c"]);
  });

  it("throws on a cycle", () => {
    expect(() => topologicalSort(["a", "b"], [dep("b", "a"), dep("a", "b")])).toThrowError();
    try {
      topologicalSort(["a", "b"], [dep("b", "a"), dep("a", "b")]);
    } catch (e) {
      expect(isDubError(e) && e.code).toBe(GANTT_CALC_DEPENDENCY_CYCLE);
    }
  });

  it("ignores dependencies whose endpoints are unknown", () => {
    expect(topologicalSort(["a"], [dep("a", "ghost")])).toEqual(["a"]);
  });
});

describe("validateDependencies", () => {
  it("reports a clean graph as valid", () => {
    const res = validateDependencies({ taskIds: ["a", "b"], dependencies: [dep("b", "a")] });
    expect(res).toEqual({ valid: true, cycles: [], unknownTaskIds: [] });
  });

  it("reports cycles AND unknown refs together without throwing (task-service import contract)", () => {
    const res = validateDependencies({
      taskIds: ["a", "b", "c"],
      dependencies: [dep("b", "a"), dep("c", "b"), dep("a", "c"), dep("a", "ghost")],
    });
    expect(res.valid).toBe(false);
    expect(res.unknownTaskIds).toEqual(["ghost"]);
    expect(res.cycles).toHaveLength(1);
    expect([...res.cycles[0]!].sort()).toEqual(["a", "b", "c"]);
  });

  it("detects a self-dependency as a cycle", () => {
    const res = validateDependencies({ taskIds: ["a"], dependencies: [dep("a", "a")] });
    expect(res.valid).toBe(false);
    expect(res.cycles).toEqual([["a"]]);
  });
});
