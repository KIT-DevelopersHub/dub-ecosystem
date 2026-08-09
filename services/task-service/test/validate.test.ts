import { describe, it, expect } from "vitest";
import { validateDependencies, assertStatusTransition } from "../src/validate";
import { isDubError } from "@dub/errors";

describe("validateDependencies (gantt-calc stub contract)", () => {
  it("passes for an acyclic graph", () => {
    expect(() =>
      validateDependencies([
        { taskId: "a", dependsOnId: "b" },
        { taskId: "b", dependsOnId: "c" },
      ]),
    ).not.toThrow();
  });

  it("throws TASK_DEPENDENCY_CYCLE for a cycle", () => {
    try {
      validateDependencies([
        { taskId: "a", dependsOnId: "b" },
        { taskId: "b", dependsOnId: "c" },
        { taskId: "c", dependsOnId: "a" },
      ]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(isDubError(err) && err.code).toBe("TASK_DEPENDENCY_CYCLE");
    }
  });
});

describe("assertStatusTransition", () => {
  it("allows legal transitions and no-ops", () => {
    expect(() => assertStatusTransition("todo", "in_progress")).not.toThrow();
    expect(() => assertStatusTransition("done", "in_progress")).not.toThrow(); // reopen
    expect(() => assertStatusTransition("todo", "todo")).not.toThrow();
  });

  it("rejects illegal transitions", () => {
    expect(() => assertStatusTransition("blocked", "done")).toThrow(); // must go via in_progress
    expect(() => assertStatusTransition("cancelled", "in_progress")).toThrow();
  });
});
