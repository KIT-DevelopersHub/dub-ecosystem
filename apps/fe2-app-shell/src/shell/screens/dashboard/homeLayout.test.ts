import { describe, it, expect } from "vitest";
import {
  computeBlocks,
  computeDensePositions,
  HOME_REGIONS,
  HOME_WIDGET_SIZES,
  isResizableWidget,
  mergeRegionOrder,
  positionStyle,
  regionOrdered,
  sizeOf,
  sortByOrder,
  spanStyle,
  swapBlocks,
  visibleRegion,
  WIDGET_SIZE_SPAN,
  type GridSpan,
  type HomeWidgetMeta,
  type WidgetBlock,
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

  // ---- mixed-size drag SWAP redesign (postmortem for PR #484 / fix/widget-area-swap-mutual)
  // Two prior fixes ("move"=arrayMove, then "swap"=dnd-kit rectSwappingStrategy+arraySwap)
  // operated on the flat id array and were regression-tested by DOM-order assertions only
  // — never by the actual on-screen geometry a `grid-auto-flow: dense` region paints, which
  // is why a real mouse drag still read as "sizes different ⇒ can't swap" even after both
  // "fixes" shipped. These tests pin the exact (row, col) a `dense` grid renders (matching
  // the CSS spec's own auto-placement algorithm) and the swap semantics derived from it.
  describe("computeDensePositions (exact `dense` auto-placement simulator)", () => {
    const span = (sizes: Record<string, GridSpan>) => (id: string) => sizes[id] ?? { col: 1, row: 1 };

    it("packs same-size small tiles left-to-right, wrapping rows", () => {
      const spanOf = span({ a: { col: 1, row: 1 }, b: { col: 1, row: 1 }, c: { col: 1, row: 1 } });
      const pos = computeDensePositions(["a", "b", "c"], spanOf, 2);
      expect(pos.get("a")).toEqual({ row: 1, col: 1 });
      expect(pos.get("b")).toEqual({ row: 1, col: 2 });
      expect(pos.get("c")).toEqual({ row: 2, col: 1 });
    });

    it("`dense` backfills a non-adjacent small into the gap a wide tile leaves — the exact\n     mechanism the previous array-swap fixes never modeled", () => {
      // [medium(A,full row), small(B), medium(C,full row), small(D)] in a 2-col grid:
      // dense does NOT put B and D on separate half-empty rows — it backfills D into
      // the half-cell B's row leaves open, because C can't fit there.
      const spanOf = span({
        A: { col: 2, row: 1 },
        B: { col: 1, row: 1 },
        C: { col: 2, row: 1 },
        D: { col: 1, row: 1 },
      });
      const pos = computeDensePositions(["A", "B", "C", "D"], spanOf, 2);
      expect(pos.get("A")).toEqual({ row: 1, col: 1 });
      expect(pos.get("B")).toEqual({ row: 2, col: 1 });
      expect(pos.get("C")).toEqual({ row: 3, col: 1 });
      expect(pos.get("D")).toEqual({ row: 2, col: 2 }); // backfilled next to B, not its own row
    });

    it("places a 2x2 large tile and lets a later small backfill beside it", () => {
      const spanOf = span({
        recent: { col: 1, row: 1 },
        events: { col: 2, row: 2 },
        notifications: { col: 1, row: 1 },
      });
      const pos = computeDensePositions(["recent", "events", "notifications"], spanOf, 2);
      expect(pos.get("recent")).toEqual({ row: 1, col: 1 });
      expect(pos.get("events")).toEqual({ row: 2, col: 1 }); // 2x2, needs a fresh 2-col row
      expect(pos.get("notifications")).toEqual({ row: 1, col: 2 }); // backfills beside recent
    });
  });

  describe("computeBlocks (swappable row-units)", () => {
    const spanOf = (sizes: Record<string, WidgetSize>) => (id: string) => WIDGET_SIZE_SPAN[sizes[id] ?? "small"];

    it("groups a `dense`-backfilled pair of NON-adjacent smalls into ONE block", () => {
      // Same arrangement as the computeDensePositions backfill test above: B and D end
      // up sharing a row even though C sits between them in the id array — they must be
      // ONE swappable block, not two, or a drag involving either would silently touch
      // the wrong widgets.
      const sizes: Record<string, WidgetSize> = { A: "medium", B: "small", C: "medium", D: "small" };
      const blocks = computeBlocks(["A", "B", "C", "D"], spanOf(sizes), 2);
      expect(blocks.map((b) => b.ids)).toEqual([["A"], ["B", "D"], ["C"]]);
    });

    it("groups the small+small pair that shares a row with a large's backfill (同面積 case)", () => {
      const sizes: Record<string, WidgetSize> = { recent: "small", events: "large", notifications: "small" };
      const blocks = computeBlocks(["recent", "events", "notifications"], spanOf(sizes), 2);
      // recent and notifications end up sharing row1 (dense backfill) — one block;
      // events (2x2) stands alone.
      expect(blocks.map((b) => b.ids)).toEqual([["recent", "notifications"], ["events"]]);
    });

    it("one medium is its own solo block beside an adjacent small pair", () => {
      const sizes: Record<string, WidgetSize> = { recent: "medium", events: "small", notifications: "small" };
      const blocks = computeBlocks(["recent", "events", "notifications"], spanOf(sizes), 2);
      expect(blocks.map((b) => b.ids)).toEqual([["recent"], ["events", "notifications"]]);
    });

    it("three solo full-width blocks when every widget is medium/large", () => {
      const sizes: Record<string, WidgetSize> = { recent: "large", events: "medium", notifications: "medium" };
      const blocks = computeBlocks(["recent", "events", "notifications"], spanOf(sizes), 2);
      expect(blocks.map((b) => b.ids)).toEqual([["recent"], ["events"], ["notifications"]]);
    });
  });

  describe("swapBlocks (a drop exchanges ENTIRE blocks, never a lone id)", () => {
    it("swaps two solo blocks and leaves every other block untouched", () => {
      const blocks: WidgetBlock[] = [{ ids: ["large-1"] }, { ids: ["medium-1"] }, { ids: ["medium-2"] }];
      expect(swapBlocks(blocks, "large-1", "medium-2")).toEqual(["medium-2", "medium-1", "large-1"]);
    });

    it("dragging a solo medium onto ONE small trades it with the small's WHOLE pair —\n     the exact semantic both prior array-swap fixes got wrong", () => {
      const blocks: WidgetBlock[] = [{ ids: ["medium"] }, { ids: ["small-1", "small-2"] }];
      // Drop the medium on small-2 specifically — the swap still moves the WHOLE pair
      // (small-1 rides along even though it was never touched by the pointer), because
      // the pair is one row-unit. Both smalls keep their relative order.
      expect(swapBlocks(blocks, "medium", "small-2")).toEqual(["small-1", "small-2", "medium"]);
    });

    it("dragging one small onto its own pair-mate swaps just those two ids in place", () => {
      const blocks: WidgetBlock[] = [{ ids: ["medium"] }, { ids: ["small-1", "small-2"] }];
      expect(swapBlocks(blocks, "small-1", "small-2")).toEqual(["medium", "small-2", "small-1"]);
    });

    it("is a no-op (returns the flattened original) when either id is unknown", () => {
      const blocks: WidgetBlock[] = [{ ids: ["a"] }, { ids: ["b", "c"] }];
      expect(swapBlocks(blocks, "a", "ghost")).toEqual(["a", "b", "c"]);
    });

    it("dragging widget onto itself is a no-op", () => {
      const blocks: WidgetBlock[] = [{ ids: ["a"] }, { ids: ["b", "c"] }];
      expect(swapBlocks(blocks, "a", "a")).toEqual(["a", "b", "c"]);
    });
  });

  describe("swap end-to-end: block-swap composed with computeDensePositions reproduces the\n    intended visual trade, and re-simulating the swapped order agrees with computeBlocks", () => {
    it("中(medium)⇄小2つ(2 small): after the swap, the 2 smalls occupy the medium's OLD\n       row and the medium occupies the smalls' OLD row — nothing else moves", () => {
      const sizes: Record<string, WidgetSize> = { recent: "medium", events: "small", notifications: "small" };
      const spanOf = (id: string) => WIDGET_SIZE_SPAN[sizes[id as keyof typeof sizes] ?? "small"];
      const before = computeDensePositions(["recent", "events", "notifications"], spanOf, 2);
      expect(before.get("recent")).toEqual({ row: 1, col: 1 });
      expect(before.get("events")).toEqual({ row: 2, col: 1 });
      expect(before.get("notifications")).toEqual({ row: 2, col: 2 });

      const blocks = computeBlocks(["recent", "events", "notifications"], spanOf, 2);
      const nextIds = swapBlocks(blocks, "recent", "notifications");
      const after = computeDensePositions(nextIds, spanOf, 2);
      // The 2-small row now sits where the medium used to be (row1); the medium now
      // sits where the small pair used to be (row2) — a true reciprocal trade.
      expect(after.get("events")).toEqual({ row: 1, col: 1 });
      expect(after.get("notifications")).toEqual({ row: 1, col: 2 });
      expect(after.get("recent")).toEqual({ row: 2, col: 1 });
    });

    it("大(large)⇄中2つ(2 separate mediums): dragging large onto the SECOND medium swaps\n       only those two — the untouched medium keeps its own row", () => {
      const sizes: Record<string, WidgetSize> = { recent: "large", events: "medium", notifications: "medium" };
      const spanOf = (id: string) => WIDGET_SIZE_SPAN[sizes[id as keyof typeof sizes] ?? "small"];
      const blocks = computeBlocks(["recent", "events", "notifications"], spanOf, 2);
      const nextIds = swapBlocks(blocks, "recent", "notifications");
      const after = computeDensePositions(nextIds, spanOf, 2);
      expect(after.get("notifications")).toEqual({ row: 1, col: 1 }); // took recent's old row
      expect(after.get("events")).toEqual({ row: 2, col: 1 }); // untouched widget, own row
      expect(after.get("recent")).toEqual({ row: 3, col: 1 }); // took notifications' old row
    });
  });

  describe("positionStyle", () => {
    it("emits an explicit line + span placement, not a span-only rule", () => {
      expect(positionStyle({ row: 2, col: 1 }, "medium")).toEqual({ gridColumn: "1 / span 2", gridRow: "2 / span 1" });
      expect(positionStyle({ row: 1, col: 2 }, "small")).toEqual({ gridColumn: "2 / span 1", gridRow: "1 / span 1" });
    });
  });
});
