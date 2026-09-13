// Unit coverage for the Home widget grid's pure packing/placement logic — no
// DOM, no react-grid-layout, just the invariants that make the feature actually
// work: 小=1x2/中=2x2 cell spans (the product owner's own examples), no two
// widgets ever overlap, an unplaced (new) widget is packed into free space
// without disturbing widgets the viewer already placed, and sizes/positions
// round-trip through the same shape react-grid-layout hands back on drag.
import { describe, expect, it } from "vitest";
import {
  colsForWidth,
  defaultLayout,
  effectiveSpan,
  hasOverlap,
  HOME_GRID_COLS_NARROW,
  HOME_GRID_COLS_WIDE,
  layoutFor,
  nextSize,
  SIZE_SPAN,
  sizeOf,
  type GridWidgetMeta,
  type HomeGridPrefs,
} from "./homeGrid.ts";

const CATALOG: GridWidgetMeta[] = [
  { id: "usage", label: "無料枠の使用状況", defaultSize: "medium" },
  { id: "tasks", label: "タスクの内訳", defaultSize: "medium" },
  { id: "recent", label: "最近開いた", defaultSize: "small" },
  { id: "events", label: "直近のイベント", defaultSize: "medium" },
  { id: "notifications", label: "未読の通知", defaultSize: "small" },
];

describe("SIZE_SPAN", () => {
  it("小=1x2, 中=2x2 — the product owner's own examples", () => {
    expect(SIZE_SPAN.small).toEqual({ w: 1, h: 2 });
    expect(SIZE_SPAN.medium).toEqual({ w: 2, h: 2 });
  });

  it("大 extends the same proportional step beyond 中", () => {
    expect(SIZE_SPAN.large.w).toBeGreaterThan(SIZE_SPAN.medium.w);
    expect(SIZE_SPAN.large.h).toBeGreaterThan(SIZE_SPAN.medium.h);
  });
});

describe("nextSize", () => {
  it("cycles 小→中→大→小", () => {
    expect(nextSize("small")).toBe("medium");
    expect(nextSize("medium")).toBe("large");
    expect(nextSize("large")).toBe("small");
  });
});

describe("colsForWidth", () => {
  it("uses the wide grid above the narrow breakpoint", () => {
    expect(colsForWidth(1200)).toBe(HOME_GRID_COLS_WIDE);
  });
  it("drops to the narrow grid below the breakpoint", () => {
    expect(colsForWidth(400)).toBe(HOME_GRID_COLS_NARROW);
  });
});

describe("effectiveSpan", () => {
  it("clamps a widget's width to the available columns (大 on a 2-col grid)", () => {
    const span = effectiveSpan("large", HOME_GRID_COLS_NARROW);
    expect(span.w).toBeLessThanOrEqual(HOME_GRID_COLS_NARROW);
    expect(span.h).toBe(SIZE_SPAN.large.h); // height is never clamped by column count
  });
});

describe("sizeOf", () => {
  it("falls back to the catalog default when the viewer has not chosen a size", () => {
    expect(sizeOf(CATALOG, {}, "usage")).toBe("medium");
    expect(sizeOf(CATALOG, {}, "recent")).toBe("small");
  });
  it("prefers the viewer's stored choice over the catalog default", () => {
    expect(sizeOf(CATALOG, { usage: "large" }, "usage")).toBe("large");
  });
  it("defaults an unknown widget (no catalog entry) to small", () => {
    expect(sizeOf(CATALOG, {}, "ghost")).toBe("small");
  });
});

describe("defaultLayout", () => {
  it("packs every widget with no overlaps at the wide column count", () => {
    const layout = defaultLayout(CATALOG, {}, HOME_GRID_COLS_WIDE);
    expect(layout).toHaveLength(CATALOG.length);
    expect(hasOverlap(layout)).toBe(false);
    for (const item of layout) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + item.w).toBeLessThanOrEqual(HOME_GRID_COLS_WIDE);
    }
  });

  it("is deterministic (same catalog+sizes+cols always yields the same layout)", () => {
    const a = defaultLayout(CATALOG, {}, HOME_GRID_COLS_WIDE);
    const b = defaultLayout(CATALOG, {}, HOME_GRID_COLS_WIDE);
    expect(a).toEqual(b);
  });

  it("packs without overlap at the narrow column count too (mixed sizes clamped)", () => {
    const layout = defaultLayout(CATALOG, {}, HOME_GRID_COLS_NARROW);
    expect(hasOverlap(layout)).toBe(false);
    for (const item of layout) {
      expect(item.x + item.w).toBeLessThanOrEqual(HOME_GRID_COLS_NARROW);
    }
  });
});

describe("layoutFor", () => {
  it("honors a viewer's stored position and never lets it overlap a freshly-packed widget", () => {
    // Viewer dragged "notifications" to the top-left; "usage"/"tasks"/"recent"/
    // "events" have never been placed (first-ever render after this partial
    // customization — e.g. localStorage seeded by hand / migrated).
    const prefs: HomeGridPrefs = { positions: { notifications: { x: 0, y: 0 } }, sizes: {} };
    const layout = layoutFor(CATALOG, prefs, HOME_GRID_COLS_WIDE);
    expect(hasOverlap(layout)).toBe(false);
    const notif = layout.find((i) => i.i === "notifications");
    expect(notif).toEqual({ i: "notifications", x: 0, y: 0, w: 1, h: 2 });
  });

  it("clamps an out-of-range stored x so a widget never renders off-grid", () => {
    const prefs: HomeGridPrefs = { positions: { usage: { x: 999, y: 0 } }, sizes: {} };
    const layout = layoutFor(CATALOG, prefs, HOME_GRID_COLS_WIDE);
    const usage = layout.find((i) => i.i === "usage")!;
    expect(usage.x + usage.w).toBeLessThanOrEqual(HOME_GRID_COLS_WIDE);
  });

  it("drops a widget that is no longer in the catalog (e.g. hidden/empty) without touching others", () => {
    const withoutRecent = CATALOG.filter((w) => w.id !== "recent");
    const prefs: HomeGridPrefs = {
      positions: { usage: { x: 0, y: 0 }, tasks: { x: 2, y: 0 }, recent: { x: 4, y: 0 } },
      sizes: {},
    };
    const layout = layoutFor(withoutRecent, prefs, HOME_GRID_COLS_WIDE);
    expect(layout.find((i) => i.i === "recent")).toBeUndefined();
    expect(hasOverlap(layout)).toBe(false);
  });

  it("reflows a resized widget's footprint without overlapping its neighbours", () => {
    // "usage" and "tasks" sit side by side (中=2x2 each) — growing "usage" to 大
    // (3x3) must not make it overlap "tasks" once re-packed at its stored spot.
    const prefs: HomeGridPrefs = {
      positions: { usage: { x: 0, y: 0 }, tasks: { x: 2, y: 0 } },
      sizes: { usage: "large" },
    };
    const layout = layoutFor(CATALOG, prefs, HOME_GRID_COLS_WIDE);
    expect(hasOverlap(layout)).toBe(false);
  });

  it("is stable in catalog order regardless of prefs key order", () => {
    const prefs: HomeGridPrefs = { positions: {}, sizes: {} };
    const layout = layoutFor(CATALOG, prefs, HOME_GRID_COLS_WIDE);
    expect(layout.map((i) => i.i)).toEqual(CATALOG.map((w) => w.id));
  });
});
