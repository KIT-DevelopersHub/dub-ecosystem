import { describe, expect, it } from "vitest";
import { barsInRect, normalizeRect, rectIsDrag, unionIds } from "../src/domain/marquee";
import { ROW_HEIGHT, type TimelineBar } from "../src/domain/timeline-axis";
import type { common } from "@dub/types";

const bar = (taskId: string, x: number, width: number, rowIndex: number, hasBar = true): TimelineBar => ({
  taskId,
  hasBar,
  x,
  width,
  y: rowIndex * ROW_HEIGHT,
  progressPercent: 0,
});

describe("normalizeRect", () => {
  it("orders corners so x0<=x1 and y0<=y1 regardless of drag direction", () => {
    expect(normalizeRect({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({ x0: 10, y0: 5, x1: 30, y1: 40 });
  });
});

describe("rectIsDrag", () => {
  it("treats a tiny rect as a click (not a marquee)", () => {
    expect(rectIsDrag({ x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(false);
  });
  it("treats a rect past the threshold as a drag", () => {
    expect(rectIsDrag({ x0: 0, y0: 0, x1: 20, y1: 1 })).toBe(true);
    expect(rectIsDrag({ x0: 0, y0: 0, x1: 1, y1: 20 })).toBe(true);
  });
});

describe("barsInRect", () => {
  // three rows: A [10..40]@row0, B [100..160]@row1, C [50..80]@row2
  const bars = [bar("A", 10, 30, 0), bar("B", 100, 60, 1), bar("C", 50, 30, 2)];

  it("selects bars whose horizontal AND row bands both overlap the rect", () => {
    // a rect over rows 0-1, x 0..120 → hits A and B, not C (row2 below)
    const hit = barsInRect(bars, { x0: 0, y0: 0, x1: 120, y1: ROW_HEIGHT + 5 });
    expect(hit).toEqual(["A", "B"]);
  });

  it("excludes a bar the rect misses horizontally even if the row overlaps", () => {
    // strictly inside row1's band (below row0), x only 0..40 → misses B (starts at 100)
    const hit = barsInRect(bars, { x0: 0, y0: ROW_HEIGHT + 1, x1: 40, y1: 2 * ROW_HEIGHT - 1 });
    expect(hit).toEqual([]);
  });

  it("selects all three with a rect that covers the whole area", () => {
    const hit = barsInRect(bars, { x0: 0, y0: 0, x1: 200, y1: 3 * ROW_HEIGHT });
    expect(hit).toEqual(["A", "B", "C"]);
  });

  it("never selects an undated (no-bar) row", () => {
    const withGap = [bar("A", 10, 30, 0), bar("X", 0, 0, 1, false)];
    const hit = barsInRect(withGap, { x0: 0, y0: 0, x1: 200, y1: 3 * ROW_HEIGHT });
    expect(hit).toEqual(["A"]);
  });

  it("counts an edge touch as a hit (inclusive)", () => {
    const hit = barsInRect(bars, { x0: 40, y0: 0, x1: 40, y1: ROW_HEIGHT });
    expect(hit).toEqual(["A"]); // rect.x0 == bar A right edge (x+width=40)
  });
});

describe("unionIds", () => {
  it("merges a hit list into an existing selection without duplicates", () => {
    const prev = new Set(["A", "B"] as common.TaskId[]);
    const next = unionIds(prev, ["B", "C"] as common.TaskId[]);
    expect([...next].sort()).toEqual(["A", "B", "C"]);
  });
});
