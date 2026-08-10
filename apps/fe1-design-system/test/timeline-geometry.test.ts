import { describe, it, expect } from "vitest";
import {
  TIMELINE_PX_PER_DAY,
  computeTimelineBounds,
  timelineBars,
  timelineTicks,
  timelineDependencySegments,
  pxToDayDelta,
  shiftMsByDays,
} from "../src/utils/timeline-geometry";
import type { TimelineRow, TimelineDependency } from "../src/types";

const DAY = 86_400_000;
const d = (iso: string) => Date.parse(iso);

const rows: TimelineRow[] = [
  { id: "a", label: "A", startMs: d("2026-01-01T00:00:00Z"), endMs: d("2026-01-03T00:00:00Z"), progressPercent: 50 },
  { id: "b", label: "B", startMs: d("2026-01-05T00:00:00Z"), endMs: d("2026-01-06T00:00:00Z"), progressPercent: 100 },
  { id: "c", label: "C (unscheduled)", startMs: null, endMs: null },
];

describe("computeTimelineBounds", () => {
  it("spans the earliest start to latest end (+1 day pad)", () => {
    const b = computeTimelineBounds(rows)!;
    expect(b.minMs).toBe(d("2026-01-01T00:00:00Z"));
    expect(b.maxMs).toBe(d("2026-01-06T00:00:00Z") + DAY);
  });

  it("returns null when no row has dates", () => {
    expect(computeTimelineBounds([{ id: "x", label: "x", startMs: null, endMs: null }])).toBeNull();
  });
});

describe("timelineBars", () => {
  const bounds = computeTimelineBounds(rows)!;
  const bars = timelineBars(rows, bounds, { scale: "day", rowHeight: 28 });

  it("positions a bar by day offset at the given scale", () => {
    const a = bars.find((x) => x.id === "a")!;
    expect(a.hasBar).toBe(true);
    expect(a.x).toBe(0);
    expect(a.width).toBe(2 * TIMELINE_PX_PER_DAY.day); // 2-day span
    expect(a.progressWidth).toBeCloseTo(a.width * 0.5);
  });

  it("keeps an unscheduled row but with no bar", () => {
    const c = bars.find((x) => x.id === "c")!;
    expect(c.hasBar).toBe(false);
    expect(c.width).toBe(0);
    expect(c.y).toBe(2 * 28);
  });

  it("clamps progress to 0..100 and applies minBarWidth", () => {
    const same: TimelineRow[] = [{ id: "z", label: "z", startMs: d("2026-01-01T00:00:00Z"), endMs: d("2026-01-01T00:00:00Z"), progressPercent: 300 }];
    const b2 = computeTimelineBounds(same)!;
    const [bar] = timelineBars(same, b2, { scale: "month", rowHeight: 20, minBarWidth: 6 });
    expect(bar!.width).toBe(6);
    expect(bar!.progressPercent).toBe(100);
  });
});

describe("timelineTicks", () => {
  it("steps weekly at week scale", () => {
    const bounds = computeTimelineBounds(rows)!;
    const ticks = timelineTicks(bounds, "week");
    expect(ticks[0]!.x).toBe(0);
    expect(ticks[0]!.label).toBe("2026-01-01");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("timelineDependencySegments", () => {
  it("links predecessor bar-end to successor bar-start and carries the violated flag", () => {
    const bounds = computeTimelineBounds(rows)!;
    const bars = timelineBars(rows, bounds, { scale: "day", rowHeight: 28 });
    const deps: TimelineDependency[] = [{ id: "d1", fromId: "a", toId: "b", violated: true }];
    const segs = timelineDependencySegments(deps, bars, 28);
    expect(segs).toHaveLength(1);
    const a = bars.find((x) => x.id === "a")!;
    const b = bars.find((x) => x.id === "b")!;
    expect(segs[0]!.x1).toBe(a.x + a.width);
    expect(segs[0]!.x2).toBe(b.x);
    expect(segs[0]!.violated).toBe(true);
  });

  it("skips deps whose endpoints have no bar", () => {
    const bounds = computeTimelineBounds(rows)!;
    const bars = timelineBars(rows, bounds, { scale: "day", rowHeight: 28 });
    const deps: TimelineDependency[] = [{ id: "d2", fromId: "a", toId: "c" }];
    expect(timelineDependencySegments(deps, bars, 28)).toHaveLength(0);
  });
});

describe("drag helpers", () => {
  it("quantizes px to whole-day deltas per scale", () => {
    expect(pxToDayDelta(TIMELINE_PX_PER_DAY.day * 3, "day")).toBe(3);
    expect(pxToDayDelta(TIMELINE_PX_PER_DAY.week * 2 + 1, "week")).toBe(2);
  });

  it("shifts ms by whole days and passes null through", () => {
    expect(shiftMsByDays(d("2026-01-01T00:00:00Z"), 2)).toBe(d("2026-01-03T00:00:00Z"));
    expect(shiftMsByDays(null, 5)).toBeNull();
  });
});
