import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import {
  computeDateBounds,
  ganttGeometry,
  dependencySegments,
  timelineTicks,
  shiftDatesByDays,
  pxToDayDelta,
  PX_PER_DAY,
  visibleTreeRows,
} from "../src/domain/gantt-layout";

const row = (id: string, s: string | null, e: string | null, pct = 0): gantt.GanttRow => ({
  taskId: id, title: id, startsAt: s, endsAt: e, progressPercent: pct, assigneeId: null,
});

describe("gantt-layout (design tests 4/5/7)", () => {
  const rows = [
    row("a", "2026-08-01T00:00:00Z", "2026-08-05T00:00:00Z", 100),
    row("b", "2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z", 0),
    row("c", null, null), // date未設定 (test 7)
  ];

  it("computes bounds across dated rows only", () => {
    const b = computeDateBounds(rows)!;
    expect(new Date(b.minMs).toISOString().slice(0, 10)).toBe("2026-08-01");
    // max padded +1 day past latest end (08-10 -> 08-11)
    expect(new Date(b.maxMs).toISOString().slice(0, 10)).toBe("2026-08-11");
  });

  it("returns null bounds when nothing is dated", () => {
    expect(computeDateBounds([row("x", null, null)])).toBeNull();
  });

  it("bar geometry: dated rows get bars; null-date row keeps a row but no bar (test 7)", () => {
    const b = computeDateBounds(rows)!;
    const boxes = ganttGeometry(rows, b, { zoom: "day", rowHeight: 20 });
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.hasBar).toBe(true);
    expect(boxes[0]!.x).toBe(0); // starts at bounds.min
    expect(boxes[0]!.width).toBeCloseTo(4 * PX_PER_DAY.day);
    expect(boxes[0]!.progressWidth).toBeCloseTo(boxes[0]!.width); // 100%
    expect(boxes[2]!.hasBar).toBe(false); // null dates
    expect(boxes[2]!.width).toBe(0);
  });

  it("dependency segment flags FS violation when successor starts before predecessor ends", () => {
    const b = computeDateBounds(rows)!;
    const boxes = ganttGeometry(rows, b, { zoom: "day", rowHeight: 20 });
    const deps: gantt.GanttDependencyLine[] = [
      { id: "a->b", fromTaskId: "a", toTaskId: "b", type: "FS", lagDays: 0 },
    ];
    // a ends 08-05, b starts 08-03 => violated
    const segs = dependencySegments(deps, boxes, rows, 20);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.isViolated).toBe(true);
  });

  it("skips dependency segments touching a bar-less row", () => {
    const b = computeDateBounds(rows)!;
    const boxes = ganttGeometry(rows, b, { zoom: "day", rowHeight: 20 });
    const deps: gantt.GanttDependencyLine[] = [{ id: "a->c", fromTaskId: "a", toTaskId: "c", type: "FS", lagDays: 0 }];
    expect(dependencySegments(deps, boxes, rows, 20)).toHaveLength(0);
  });

  it("timeline ticks step by zoom", () => {
    const b = computeDateBounds(rows)!;
    expect(timelineTicks(b, "day").length).toBeGreaterThan(timelineTicks(b, "month").length);
  });

  it("bar D&D helpers: shift dates and quantize px to days (test 5)", () => {
    const shifted = shiftDatesByDays("2026-08-01T00:00:00Z", "2026-08-05T00:00:00Z", 2);
    expect(shifted.startsAt).toBe("2026-08-03T00:00:00.000Z");
    expect(shifted.endsAt).toBe("2026-08-07T00:00:00.000Z");
    expect(pxToDayDelta(PX_PER_DAY.day * 3 + 5, "day")).toBe(3);
    expect(shiftDatesByDays(null, null, 5)).toEqual({ startsAt: null, endsAt: null });
  });
});

describe("visibleTreeRows — recursive WBS collapse (祖先が閉じれば子孫は必ず非表示)", () => {
  // 3-level tree: P(parent) -> C(child) -> G(grandchild)
  const tree = (): gantt.GanttRow[] => [
    { ...row("P", null, null), parentTaskId: null, hasChildren: true, depth: 0 },
    { ...row("C", null, null), parentTaskId: "P", hasChildren: true, depth: 1 },
    { ...row("G", null, null), parentTaskId: "C", hasChildren: false, depth: 2 },
  ];
  const ids = (rs: gantt.GanttRow[]) => rs.map((r) => r.taskId);

  it("all ancestors open ⇒ every row visible", () => {
    expect(ids(visibleTreeRows(tree(), new Set(["P", "C"])))).toEqual(["P", "C", "G"]);
  });

  it("collapsing the child hides the grandchild", () => {
    // P open, C closed ⇒ C visible, G hidden
    expect(ids(visibleTreeRows(tree(), new Set(["P"])))).toEqual(["P", "C"]);
  });

  it("collapsing an ancestor hides deep descendants even when the child's own toggle stays open (the bug)", () => {
    // P collapsed but C still marked open in the toggle set: G must NOT stay visible.
    expect(ids(visibleTreeRows(tree(), new Set(["C"])))).toEqual(["P"]);
  });

  it("re-expanding an ancestor restores the subtree using each node's preserved toggle state", () => {
    const rows = tree();
    // Grandchild's parent C was left open; only P was collapsed. Re-opening P should
    // bring back C AND G (because C's open state was preserved), not just C.
    expect(ids(visibleTreeRows(rows, new Set(["P", "C"])))).toEqual(["P", "C", "G"]);
    // If instead C had been collapsed by the user, re-opening P shows C but keeps G hidden.
    expect(ids(visibleTreeRows(rows, new Set(["P"])))).toEqual(["P", "C"]);
  });

  it("is cycle-safe against a malformed parent loop", () => {
    const cyclic: gantt.GanttRow[] = [
      { ...row("X", null, null), parentTaskId: "Y" },
      { ...row("Y", null, null), parentTaskId: "X" },
    ];
    // Neither open ⇒ both hidden, and no infinite loop.
    expect(ids(visibleTreeRows(cyclic, new Set()))).toEqual([]);
  });
});
