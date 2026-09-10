import { describe, it, expect } from "vitest";
import { swapAt } from "./HomeEditableRegion.tsx";

// `swapAt` is the pure ordering rule behind the mixed-size widget drag fix (see
// HomeEditableRegion's onReorder + SortableList's reorderMode="swap"): a drop must
// exchange EXACTLY the dragged widget and its drop target, leaving every other
// widget's position untouched — a plain arrayMove/insert would instead shift every
// widget BETWEEN the two positions by one slot, which is correct for a uniform list
// but not for "swap this small tile with that large one" (the regression this fixes;
// full real-browser proof lives in
// apps/fe2-app-shell/e2e/home-widget-area-swap-mutual.spec.ts).
describe("swapAt", () => {
  it("exchanges exactly the two given indices", () => {
    expect(swapAt(["a", "b", "c"], 0, 2)).toEqual(["c", "b", "a"]);
  });

  it("leaves every widget between the two positions untouched (unlike a shift/move)", () => {
    // If this were arrayMove(0,2) instead, "b" would shift to index 0 (['b','c','a']).
    // A true swap keeps "b" exactly where it was.
    const result = swapAt(["large", "medium-untouched", "medium"], 0, 2);
    expect(result[1]).toBe("medium-untouched");
    expect(result).toEqual(["medium", "medium-untouched", "large"]);
  });

  it("is its own inverse (swapping back restores the original order)", () => {
    const original = ["a", "b", "c", "d"];
    const swapped = swapAt(original, 1, 3);
    expect(swapAt(swapped, 1, 3)).toEqual(original);
  });

  it("is a no-op for equal indices", () => {
    const ids = ["a", "b", "c"];
    expect(swapAt(ids, 1, 1)).toEqual(ids);
  });

  it("is a no-op for an out-of-range index (defensive — never crashes on a stale index)", () => {
    const ids = ["a", "b", "c"];
    expect(swapAt(ids, -1, 1)).toEqual(ids);
    expect(swapAt(ids, 0, 5)).toEqual(ids);
  });

  it("adjacent swap matches what a simple move would do (no visible regression for the common 2-item case)", () => {
    expect(swapAt(["a", "b"], 0, 1)).toEqual(["b", "a"]);
  });
});
