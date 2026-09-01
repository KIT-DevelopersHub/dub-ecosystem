import { describe, it, expect } from "vitest";
import type { common, gantt } from "@dub/types";
import { deriveCriticalTaskIds } from "../src/domain/critical-path";

// day(n) -> an ISO datetime n whole days after a fixed epoch, so durationDaysOf
// reads clean whole-day spans.
const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const day = (n: number): common.ISODateTime => new Date(EPOCH + n * DAY).toISOString() as common.ISODateTime;

function row(id: string, startDay: number | null, endDay: number | null): gantt.GanttRow {
  return {
    taskId: id as common.TaskId,
    title: id,
    startsAt: startDay === null ? null : day(startDay),
    endsAt: endDay === null ? null : day(endDay),
    progressPercent: 0,
    assigneeId: null,
  };
}

function dep(from: string, to: string): gantt.GanttDependencyLine {
  return {
    id: `${from}->${to}`,
    fromTaskId: from as common.TaskId,
    toTaskId: to as common.TaskId,
    type: "FS",
    lagDays: 0,
  };
}

describe("deriveCriticalTaskIds", () => {
  it("returns an empty set for no rows", () => {
    expect(deriveCriticalTaskIds([], [])).toEqual(new Set());
  });

  it("marks a tight FS chain fully critical and a parallel slack task not", () => {
    const rows = [
      row("t1", 0, 2),
      row("t2", 2, 4),
      row("t3", 4, 6),
      row("slack", 0, 1), // short, unconnected -> has float
    ];
    const deps = [dep("t1", "t2"), dep("t2", "t3")];
    const critical = deriveCriticalTaskIds(rows, deps);
    expect(critical.has("t1" as common.TaskId)).toBe(true);
    expect(critical.has("t2" as common.TaskId)).toBe(true);
    expect(critical.has("t3" as common.TaskId)).toBe(true);
    expect(critical.has("slack" as common.TaskId)).toBe(false);
  });

  it("follows a duration change: the critical path moves to the now-longer branch", () => {
    // Diamond: t1 -> {t2, t3} -> t4. Branch t2 is longer, so t1,t2,t4 are critical.
    const longT2 = [
      row("t1", 0, 2),
      row("t2", 2, 7), // 5 days (long branch)
      row("t3", 2, 4), // 2 days (short branch, slack)
      row("t4", 7, 8),
    ];
    const deps = [dep("t1", "t2"), dep("t1", "t3"), dep("t2", "t4"), dep("t3", "t4")];
    const c1 = deriveCriticalTaskIds(longT2, deps);
    expect([...c1].sort()).toEqual(["t1", "t2", "t4"]);
    expect(c1.has("t3" as common.TaskId)).toBe(false);

    // Now make t3 the long branch (change its period) and shorten t2 — the red path
    // must swing to t1,t3,t4. This is the "期間を変えたら経路が変わる" guarantee.
    const longT3 = [
      row("t1", 0, 2),
      row("t2", 2, 4), // now short
      row("t3", 2, 7), // now long
      row("t4", 7, 8),
    ];
    const c2 = deriveCriticalTaskIds(longT3, deps);
    expect([...c2].sort()).toEqual(["t1", "t3", "t4"]);
    expect(c2.has("t2" as common.TaskId)).toBe(false);
  });

  it("follows a dependency change: dropping the edge into the long branch reshapes the path", () => {
    const rows = [row("a", 0, 2), row("b", 2, 8), row("c", 2, 3)];
    // With a->b, b is the long critical branch.
    const withB = deriveCriticalTaskIds(rows, [dep("a", "b")]);
    expect(withB.has("a" as common.TaskId)).toBe(true);
    expect(withB.has("b" as common.TaskId)).toBe(true);
    // Swap the dependency to the short branch a->c: the zero-slack set changes.
    const withC = deriveCriticalTaskIds(rows, [dep("a", "c")]);
    expect(withC).not.toEqual(withB);
  });

  it("degrades to an empty set on a dependency cycle (no throw, no infinite loop)", () => {
    const rows = [row("x", 0, 2), row("y", 2, 4)];
    const cyclic = [dep("x", "y"), dep("y", "x")];
    expect(deriveCriticalTaskIds(rows, cyclic)).toEqual(new Set());
  });

  it("tolerates null-dated rows (no bar) as zero-duration anchors", () => {
    const rows = [row("p", null, null), row("q", 0, 3)];
    // Should not throw; q (the only dated task) is trivially on its own path.
    const c = deriveCriticalTaskIds(rows, [dep("p", "q")]);
    expect(c.has("q" as common.TaskId)).toBe(true);
  });
});
