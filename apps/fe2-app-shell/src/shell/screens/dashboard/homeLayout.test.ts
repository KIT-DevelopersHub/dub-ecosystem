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

    // ── area-equivalence swap: 小2=中1, 中2=大1 (iOS 風) ───────────────────────────
    // The whole "mixed sizes interchange in the same grid" feature rests on this one
    // invariant: each size's cell-area (col-span × row-span) is exactly double the
    // one below it. As long as this holds, a native CSS Grid with `grid-auto-flow:
    // dense` back-fills a same-area group (2 small ⇄ 1 medium, 2 medium ⇄ 1 large,
    // 1 medium + 2 small ⇄ 1 large) with no custom bin-packing code — see
    // HomeEditableRegion/global.css. This test is the regression guard for that
    // invariant so nobody can change WIDGET_SIZE_SPAN and silently break the ratio.
    it("cell-area doubles at each size step (小1 = 中2分の1 = 大4分の1)", () => {
      const area = (s: WidgetSize) => {
        const span = spanStyle(s);
        const cols = Number(span.gridColumn.replace("span ", ""));
        const rows = Number(span.gridRow.replace("span ", ""));
        return cols * rows;
      };
      const small = area("small");
      const medium = area("medium");
      const large = area("large");
      expect(small).toBe(1);
      expect(medium).toBe(small * 2);
      expect(large).toBe(medium * 2);
      expect(large).toBe(small * 4);
    });

    // ── swap成立: サイズをまたいだ並べ替えが region 越境なしで成立する ──────────────────
    // mergeRegionOrder/regionOrdered never look at size — a drag that moves a small
    // widget to where a medium widget sat (or vice versa) is just an array move; the
    // resulting grid position comes from the browser's dense-fill, not from this
    // logic. This proves the order layer stays size-agnostic so that swap works for
    // ANY size combination without special-casing.
    it("reordering across mixed sizes never depends on size and never crosses regions", () => {
      const mixed: HomeWidgetMeta[] = [
        { id: "side-large", label: "大", region: "side", defaultSize: "large" },
        { id: "side-medium-1", label: "中1", region: "side", defaultSize: "medium" },
        { id: "side-medium-2", label: "中2", region: "side", defaultSize: "medium" },
        { id: "side-small-1", label: "小1", region: "side", defaultSize: "small" },
        { id: "side-small-2", label: "小2", region: "side", defaultSize: "small" },
        { id: "kpi-only", label: "K", region: "kpi" },
      ];
      // Drag "小1"+"小2" to sit where "中1" was (i.e. right after "大", before "中1"):
      // the same area-swap the user does by hand (小2つ ⇄ 中1つ).
      const next = mergeRegionOrder(mixed, [], "side", [
        "side-large",
        "side-small-1",
        "side-small-2",
        "side-medium-1",
        "side-medium-2",
      ]);
      expect(regionOrdered(mixed, next, "side").map((w) => w.id)).toEqual([
        "side-large",
        "side-small-1",
        "side-small-2",
        "side-medium-1",
        "side-medium-2",
      ]);
      // The untouched kpi region is unaffected — no cross-region leakage from the swap.
      expect(regionOrdered(mixed, next, "kpi").map((w) => w.id)).toEqual(["kpi-only"]);
      // sizeOf keeps reporting each widget's own size — reordering never mutates it.
      expect(sizeOf(mixed, {}, "side-small-1")).toBe("small");
      expect(sizeOf(mixed, {}, "side-medium-1")).toBe("medium");
      expect(sizeOf(mixed, {}, "side-large")).toBe("large");
    });
  });
});
