import { describe, it, expect } from "vitest";
import {
  HOME_REGIONS,
  mergeRegionOrder,
  regionOrdered,
  sortByOrder,
  visibleRegion,
  type HomeWidgetMeta,
} from "./homeLayout.ts";

const CATALOG: HomeWidgetMeta[] = [
  { id: "kpi-a", label: "A", region: "kpi" },
  { id: "kpi-b", label: "B", region: "kpi" },
  { id: "kpi-c", label: "C", region: "kpi" },
  { id: "card-x", label: "X", region: "cards" },
  { id: "card-y", label: "Y", region: "cards" },
  { id: "section-apps", label: "Apps", region: "apps" },
  { id: "panel-1", label: "P1", region: "side" },
  { id: "panel-2", label: "P2", region: "side" },
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
});
