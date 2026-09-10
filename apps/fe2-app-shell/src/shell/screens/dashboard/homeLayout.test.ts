import { describe, it, expect } from "vitest";
import {
  HOME_REGIONS,
  HOME_WIDGET_SIZES,
  isResizableWidget,
  mergeRegionOrder,
  regionOrdered,
  sizeOf,
  sortByOrder,
  spanStyle,
  visibleRegion,
  type HomeWidgetMeta,
  type WidgetSize,
} from "./homeLayout.ts";

const CATALOG: HomeWidgetMeta[] = [
  { id: "kpi-a", label: "A", region: "kpi" },
  { id: "kpi-b", label: "B", region: "kpi" },
  { id: "kpi-c", label: "C", region: "kpi" },
  { id: "card-x", label: "X", region: "cards" },
  { id: "card-y", label: "Y", region: "cards" },
  { id: "section-apps", label: "Apps", region: "apps", resizable: false },
  { id: "panel-1", label: "P1", region: "side", defaultSize: "medium" },
  { id: "panel-2", label: "P2", region: "side", defaultSize: "medium" },
];

describe("homeLayout", () => {
  it("falls back to catalog order when no preference is stored", () => {
    expect(regionOrdered(CATALOG, [], "kpi").map((w) => w.id)).toEqual(["kpi-a", "kpi-b", "kpi-c"]);
  });

  it("sortByOrder honours the preferred order, then catalog order for the rest", () => {
    const order = ["kpi-c", "kpi-a"];
    expect(sortByOrder(CATALOG.filter((w) => w.region === "kpi"), CATALOG, order).map((w) => w.id)).toEqual([
      "kpi-c",
      "kpi-a",
      "kpi-b",
    ]);
  });

  it("visibleRegion drops hidden widgets but keeps the order", () => {
    const order = ["kpi-c", "kpi-b", "kpi-a"];
    const hidden = ["kpi-b"];
    expect(visibleRegion(CATALOG, order, hidden, "kpi").map((w) => w.id)).toEqual(["kpi-c", "kpi-a"]);
  });

  it("mergeRegionOrder replaces only the changed region and keeps others valid", () => {
    const next = mergeRegionOrder(CATALOG, [], "cards", ["card-y", "card-x"]);
    // The cards region is reordered; every other region keeps default order; the result
    // is a full permutation covering all regions in fixed sequence.
    expect(next).toEqual(["kpi-a", "kpi-b", "kpi-c", "card-y", "card-x", "section-apps", "panel-1", "panel-2"]);
    // Applying it back yields the reordered cards.
    expect(regionOrdered(CATALOG, next, "cards").map((w) => w.id)).toEqual(["card-y", "card-x"]);
    // Widgets never cross regions.
    expect(regionOrdered(CATALOG, next, "kpi").map((w) => w.id)).toEqual(["kpi-a", "kpi-b", "kpi-c"]);
  });

  it("exposes the four fixed regions in render order", () => {
    expect(HOME_REGIONS).toEqual(["kpi", "cards", "apps", "side"]);
  });

  // ── P3-4: iOS 風 3 サイズ (small/medium/large) ─────────────────────────────────
  describe("widget size", () => {
    it("exposes the three sizes small/medium/large", () => {
      expect(HOME_WIDGET_SIZES).toEqual(["small", "medium", "large"]);
    });

    it("sizeOf falls back to small when no size is stored and the widget has no default", () => {
      expect(sizeOf(CATALOG, {}, "kpi-a")).toBe("small");
    });

    it("sizeOf falls back to the catalog's defaultSize when no size is stored", () => {
      expect(sizeOf(CATALOG, {}, "panel-1")).toBe("medium");
    });

    it("sizeOf prefers a stored size over the catalog default", () => {
      expect(sizeOf(CATALOG, { "panel-1": "large" }, "panel-1")).toBe("large");
    });

    it("sizeOf ignores a malformed stored value and falls back", () => {
      const sizes = { "kpi-a": "huge" as unknown as WidgetSize };
      expect(sizeOf(CATALOG, sizes, "kpi-a")).toBe("small");
    });

    it("sizeOf always reports small for a non-resizable widget, even with a stored size", () => {
      expect(sizeOf(CATALOG, { "section-apps": "large" }, "section-apps")).toBe("small");
    });

    it("sizeOf reports small for an unknown widget id", () => {
      expect(sizeOf(CATALOG, {}, "does-not-exist")).toBe("small");
    });

    it("isResizableWidget reflects the catalog's resizable flag (default true)", () => {
      expect(isResizableWidget(CATALOG.find((w) => w.id === "kpi-a")!)).toBe(true);
      expect(isResizableWidget(CATALOG.find((w) => w.id === "section-apps")!)).toBe(false);
    });

    it("spanStyle maps each size to its CSS Grid column/row span", () => {
      expect(spanStyle("small")).toEqual({ gridColumn: "span 1", gridRow: "span 1" });
      expect(spanStyle("medium")).toEqual({ gridColumn: "span 2", gridRow: "span 1" });
      expect(spanStyle("large")).toEqual({ gridColumn: "span 2", gridRow: "span 2" });
    });
  });
});
