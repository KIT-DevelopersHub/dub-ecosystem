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
