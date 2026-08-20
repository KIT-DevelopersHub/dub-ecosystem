import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import {
  MS_PER_DAY,
  PX_PER_DAY,
  initialWindow,
  extendWindow,
  withGranularity,
  xOf,
  canvasWidth,
  dayAtX,
  todayX,
  pxToDays,
  topSegments,
  bottomTicks,
  weekendBands,
  timelineBars,
  shiftBar,
  floorDayUtc,
  rollupRowDates,
  scaleChildrenForParentResize,
} from "../src/domain/timeline-axis";

const row = (id: string, s: string | null, e: string | null, pct = 0): gantt.GanttRow => ({
  taskId: id, title: id, startsAt: s, endsAt: e, progressPercent: pct, assigneeId: null,
});

const NOW = Date.parse("2026-08-12T00:00:00Z");

describe("timeline-axis — endless (no-terminus) axis", () => {
  const rows = [
    row("a", "2026-08-05T00:00:00Z", "2026-08-07T00:00:00Z", 100),
    row("b", "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", 0),
    row("c", null, null),
  ];

  it("window always contains today AND the latest task, with buffer past the end", () => {
    const w = initialWindow(rows, "week", NOW);
    // today is inside
    expect(NOW).toBeGreaterThanOrEqual(w.originMs);
    expect(NOW).toBeLessThan(w.endMs);
    // the last task (9/3) is NOT the terminus — the axis extends well beyond it
    const lastTaskEnd = Date.parse("2026-09-03T00:00:00Z");
    expect(w.endMs).toBeGreaterThan(lastTaskEnd + 100 * MS_PER_DAY);
  });

  it("extendWindow grows the end without moving the origin (scrollLeft stays valid)", () => {
    const w = initialWindow(rows, "week", NOW);
    const w2 = extendWindow(w, 180);
    expect(w2.originMs).toBe(w.originMs); // origin fixed
    expect(w2.endMs).toBe(w.endMs + 180 * MS_PER_DAY); // end grew
    expect(canvasWidth(w2)).toBeGreaterThan(canvasWidth(w));
  });

  it("today marker is always defined (never off-span)", () => {
    const w = initialWindow(rows, "day", NOW);
    const x = todayX(w, NOW);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(canvasWidth(w));
  });

  it("xOf and dayAtX round-trip a day", () => {
    const w = initialWindow(rows, "day", NOW);
    const day = floorDayUtc(Date.parse("2026-08-20T00:00:00Z"));
    expect(dayAtX(xOf(day, w), w)).toBe(day);
  });

  it("withGranularity keeps span, changes px", () => {
    const w = initialWindow(rows, "week", NOW);
    const d = withGranularity(w, "day");
    expect(d.originMs).toBe(w.originMs);
    expect(d.endMs).toBe(w.endMs);
    expect(d.px).toBe(PX_PER_DAY.day);
  });

  it("pxToDays quantizes a drag to whole days", () => {
    const w = withGranularity(initialWindow(rows, "day", NOW), "day");
    expect(pxToDays(PX_PER_DAY.day * 3 + 4, w)).toBe(3);
    expect(pxToDays(-PX_PER_DAY.day * 2, w)).toBe(-2);
  });
});

describe("timeline-axis — header tiers", () => {
  const rows = [row("a", "2026-08-05T00:00:00Z", "2026-08-10T00:00:00Z")];

  it("day granularity: top=months, bottom=one cell per day", () => {
    const w = initialWindow(rows, "day", NOW);
    const tops = topSegments(w, "day");
    const bots = bottomTicks(w, "day", NOW);
    expect(tops.every((s) => /年.+月/.test(s.label))).toBe(true);
    // consecutive day ticks are exactly one px-per-day apart
    expect(bots[1]!.x - bots[0]!.x).toBeCloseTo(PX_PER_DAY.day, 5);
    expect(bots.some((t) => t.isToday)).toBe(true);
  });

  it("month granularity: top=years, bottom=month names", () => {
    const w = initialWindow(rows, "month", NOW);
    const tops = topSegments(w, "month");
    const bots = bottomTicks(w, "month", NOW);
    expect(tops.every((s) => /年$/.test(s.label))).toBe(true);
    expect(bots.every((s) => /月$/.test(s.label))).toBe(true);
  });

  it("weekend bands exist at day/week scale and are dropped at month scale", () => {
    const w = initialWindow(rows, "day", NOW);
    expect(weekendBands(w, "day").length).toBeGreaterThan(0);
    expect(weekendBands(w, "month")).toHaveLength(0);
  });
});

describe("timeline-axis — bars & drag", () => {
  const rows = [
    row("a", "2026-08-05T00:00:00Z", "2026-08-08T00:00:00Z", 50),
    row("c", null, null),
  ];

  it("dated rows get bars; null-date row keeps a slot but no bar", () => {
    const w = initialWindow(rows, "day", NOW);
    const bars = timelineBars(rows, w);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.hasBar).toBe(true);
    expect(bars[0]!.width).toBeGreaterThan(0);
    expect(bars[1]!.hasBar).toBe(false);
    expect(bars[1]!.width).toBe(0);
  });

  it("shiftBar: move slides both edges; resize slides one and keeps >=1 day", () => {
    const s = "2026-08-05T00:00:00Z";
    const e = "2026-08-08T00:00:00Z";
    const moved = shiftBar(s, e, 2, "move");
    expect(moved.startsAt).toBe("2026-08-07T00:00:00.000Z");
    expect(moved.endsAt).toBe("2026-08-10T00:00:00.000Z");
    const grown = shiftBar(s, e, 2, "resize-end");
    expect(grown.startsAt).toBe("2026-08-05T00:00:00.000Z");
    expect(grown.endsAt).toBe("2026-08-10T00:00:00.000Z");
    // resize-start cannot cross the end (min 1 day)
    const clamped = shiftBar(s, e, 99, "resize-start");
    expect(Date.parse(clamped.startsAt)).toBe(Date.parse(e) - MS_PER_DAY);
  });

  it("scaleChildrenForParentResize: dragging the END edge stretches children about the start", () => {
    // parent span = [08-10, 08-20] (10 days), two children filling it.
    const parentSpan = { startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" };
    const kids = [
      { taskId: "c1", startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-15T00:00:00Z" },
      { taskId: "c2", startsAt: "2026-08-15T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" },
    ];
    // grow the end by +10 days → span doubles (f=2), anchored at 08-10.
    const out = scaleChildrenForParentResize(parentSpan, kids, "end", 10);
    const byId = Object.fromEntries(out.map((o) => [o.taskId, o])) as Record<string, { startsAt: string; endsAt: string }>;
    expect(byId.c1!.startsAt).toBe("2026-08-10T00:00:00.000Z"); // start anchor unchanged
    expect(byId.c1!.endsAt).toBe("2026-08-20T00:00:00.000Z"); // 5d → 10d
    expect(byId.c2!.startsAt).toBe("2026-08-20T00:00:00.000Z");
    expect(byId.c2!.endsAt).toBe("2026-08-30T00:00:00.000Z"); // last child end reaches the new parent end
  });

  it("scaleChildrenForParentResize: dragging the START edge scales about the end; min 1-day span; no-op safe", () => {
    const parentSpan = { startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" };
    const kids = [{ taskId: "c1", startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" }];
    // pull the start earlier by 10 days → span doubles about the end (08-20).
    const grown = scaleChildrenForParentResize(parentSpan, kids, "start", -10);
    expect(grown[0]!.startsAt).toBe("2026-07-31T00:00:00.000Z"); // 08-20 − 20d
    expect(grown[0]!.endsAt).toBe("2026-08-20T00:00:00.000Z"); // end anchor unchanged
    // deltaDays 0 and dateless children → no changes.
    expect(scaleChildrenForParentResize(parentSpan, kids, "end", 0)).toEqual([]);
    expect(scaleChildrenForParentResize(parentSpan, [{ taskId: "x", startsAt: null, endsAt: null }], "end", 5)).toEqual([]);
  });
});

// helper: a WBS row with parent/depth/hasChildren overlay
const wrow = (
  id: string,
  s: string | null,
  e: string | null,
  extra: Partial<gantt.GanttRow> = {},
): gantt.GanttRow => ({ ...row(id, s, e), ...extra });

describe("rollupRowDates — parent bars enclose their children (feedback #2)", () => {
  it("parent span widens to the union of its children (parent >= all children)", () => {
    const rows = [
      wrow("p", "2026-08-10T00:00:00Z", "2026-08-15T00:00:00Z", { hasChildren: true }),
      wrow("c1", "2026-08-05T00:00:00Z", "2026-08-12T00:00:00Z", { parentTaskId: "p", depth: 1 }),
      wrow("c2", "2026-08-14T00:00:00Z", "2026-08-20T00:00:00Z", { parentTaskId: "p", depth: 1 }),
    ];
    const out = rollupRowDates(rows);
    const p = out.find((r) => r.taskId === "p")!;
    // start = earliest child (8/5), end = latest child (8/20)
    expect(p.startsAt).toBe("2026-08-05T00:00:00.000Z");
    expect(p.endsAt).toBe("2026-08-20T00:00:00.000Z");
    // children are untouched
    expect(out.find((r) => r.taskId === "c1")!.startsAt).toBe("2026-08-05T00:00:00Z");
    expect(out.find((r) => r.taskId === "c2")!.endsAt).toBe("2026-08-20T00:00:00Z");
  });

  it("a manually-narrowed parent never splits a child (union still covers all children)", () => {
    const rows = [
      wrow("p", "2026-08-12T00:00:00Z", "2026-08-13T00:00:00Z", { hasChildren: true }),
      wrow("c", "2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z", { parentTaskId: "p", depth: 1 }),
    ];
    const p = rollupRowDates(rows).find((r) => r.taskId === "p")!;
    expect(p.startsAt).toBe("2026-08-01T00:00:00.000Z");
    expect(p.endsAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("widening a child grows the parent (child edit propagates up)", () => {
    const base = [
      wrow("p", null, null, { hasChildren: true }),
      wrow("c", "2026-08-10T00:00:00Z", "2026-08-12T00:00:00Z", { parentTaskId: "p", depth: 1 }),
    ];
    const before = rollupRowDates(base).find((r) => r.taskId === "p")!;
    expect(before.endsAt).toBe("2026-08-12T00:00:00.000Z");
    // child's end pushed out by a resize
    base[1] = wrow("c", "2026-08-10T00:00:00Z", "2026-08-25T00:00:00Z", { parentTaskId: "p", depth: 1 });
    const after = rollupRowDates(base).find((r) => r.taskId === "p")!;
    expect(after.endsAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("multi-level trees roll up bottom-up (grandparent covers grandchildren)", () => {
    const rows = [
      wrow("gp", "2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z", { hasChildren: true }),
      wrow("p", "2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z", { parentTaskId: "gp", depth: 1, hasChildren: true }),
      wrow("gc", "2026-08-01T00:00:00Z", "2026-08-28T00:00:00Z", { parentTaskId: "p", depth: 2 }),
    ];
    const out = rollupRowDates(rows);
    expect(out.find((r) => r.taskId === "p")!.endsAt).toBe("2026-08-28T00:00:00.000Z");
    expect(out.find((r) => r.taskId === "gp")!.endsAt).toBe("2026-08-28T00:00:00.000Z");
    expect(out.find((r) => r.taskId === "gp")!.startsAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("flat lists (no hierarchy) pass through unchanged", () => {
    const rows = [row("a", "2026-08-05T00:00:00Z", "2026-08-08T00:00:00Z")];
    expect(rollupRowDates(rows)).toBe(rows);
  });
});
