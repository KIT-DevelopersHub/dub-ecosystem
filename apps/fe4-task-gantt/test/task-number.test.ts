import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { computeTaskNumbers, sanitizePrefix, DEFAULT_PREFIX } from "../src/domain/task-number";

const row = (id: string, parentTaskId: string | null = null): gantt.GanttRow => ({
  taskId: id,
  title: id,
  startsAt: null,
  endsAt: null,
  progressPercent: 0,
  assigneeId: null,
  ...(parentTaskId ? { parentTaskId } : {}),
});

describe("computeTaskNumbers", () => {
  it("numbers a flat list AA-1, AA-2, AA-3 by display order", () => {
    const n = computeTaskNumbers([row("a"), row("b"), row("c")], "AA");
    expect(n.get("a")).toBe("AA-1");
    expect(n.get("b")).toBe("AA-2");
    expect(n.get("c")).toBe("AA-3");
  });

  it("nests children as parent-number + sibling index (AA-1-1, AA-1-2, AA-2)", () => {
    const rows = [
      row("p1"),
      row("c1", "p1"),
      row("c2", "p1"),
      row("p2"),
      row("c3", "p2"),
    ];
    const n = computeTaskNumbers(rows, "AA");
    expect(n.get("p1")).toBe("AA-1");
    expect(n.get("c1")).toBe("AA-1-1");
    expect(n.get("c2")).toBe("AA-1-2");
    expect(n.get("p2")).toBe("AA-2");
    expect(n.get("c3")).toBe("AA-2-1");
  });

  it("supports 3+ levels of depth", () => {
    const rows = [row("a"), row("b", "a"), row("c", "b")];
    const n = computeTaskNumbers(rows, "AA");
    expect(n.get("a")).toBe("AA-1");
    expect(n.get("b")).toBe("AA-1-1");
    expect(n.get("c")).toBe("AA-1-1-1");
  });

  it("re-numbers when the order changes (order-dependent WBS)", () => {
    const before = computeTaskNumbers([row("a"), row("b")], "AA");
    const after = computeTaskNumbers([row("b"), row("a")], "AA");
    expect(before.get("a")).toBe("AA-1");
    expect(after.get("a")).toBe("AA-2");
    expect(after.get("b")).toBe("AA-1");
  });

  it("honours a custom prefix and an empty prefix (bare code)", () => {
    expect(computeTaskNumbers([row("a")], "P").get("a")).toBe("P-1");
    expect(computeTaskNumbers([row("a"), row("b", "a")], "").get("b")).toBe("1-1");
  });

  it("falls back to a top-level number for an orphan (parent absent / forward ref)", () => {
    // child listed with a parent that isn't in the row set → treated as top-level
    const n = computeTaskNumbers([row("only", "missing")], "AA");
    expect(n.get("only")).toBe("AA-1");
  });

  it("does not crash on a self-referential parent (cycle-proof)", () => {
    const n = computeTaskNumbers([row("x", "x")], "AA");
    // parent not yet numbered when the row is visited → top-level
    expect(n.get("x")).toBe("AA-1");
  });
});

describe("sanitizePrefix", () => {
  it("strips whitespace and caps length", () => {
    expect(sanitizePrefix("  A B  ")).toBe("AB");
    expect(sanitizePrefix("ABCDEFGHIJK")).toBe("ABCDEFGH");
  });
  it("default prefix is AA", () => {
    expect(DEFAULT_PREFIX).toBe("AA");
  });
});
