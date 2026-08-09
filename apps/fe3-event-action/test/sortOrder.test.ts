import { describe, it, expect } from "vitest";
import { SORT_GAP, nextSortOrder, midpoint, computeReorder, type Ordered } from "../src/lib/sortOrder";

const list: Ordered[] = [
  { id: "a", sortOrder: 1024 },
  { id: "b", sortOrder: 2048 },
  { id: "c", sortOrder: 3072 },
];

describe("sortOrder gap method (test observation #6)", () => {
  it("appends with a full gap", () => {
    expect(nextSortOrder([])).toBe(SORT_GAP);
    expect(nextSortOrder(list)).toBe(4096);
  });

  it("midpoint between neighbours", () => {
    expect(midpoint(1024, 2048)).toBe(1536);
    expect(midpoint(null, 1024)).toBe(0);
    expect(midpoint(3072, null)).toBe(4096);
    expect(midpoint(null, null)).toBe(SORT_GAP);
  });

  it("signals normalization when the gap is exhausted", () => {
    expect(midpoint(1024, 1025)).toBeNull();
  });

  it("moving down lands after the target (arrayMove semantics)", () => {
    // move a onto c -> [b, c, a]; a lands after c(3072) with a full gap = 4096
    const r = computeReorder(list, "a", "c");
    expect(r).toEqual({ id: "a", sortOrder: 4096, needsNormalization: false });
  });

  it("moving up lands before the target", () => {
    // move c to a's slot -> before a(1024) = 0
    const r = computeReorder(list, "c", "a");
    expect(r).toEqual({ id: "c", sortOrder: 0, needsNormalization: false });
  });

  it("no-op / unknown ids return null", () => {
    expect(computeReorder(list, "a", "a")).toBeNull();
    expect(computeReorder(list, "a", "zzz")).toBeNull();
  });

  it("flags normalization when neighbours are adjacent", () => {
    const tight: Ordered[] = [
      { id: "x", sortOrder: 10 },
      { id: "y", sortOrder: 11 },
      { id: "z", sortOrder: 12 },
    ];
    const r = computeReorder(tight, "z", "y");
    // insert z before y -> between x(10) and y(11) -> exhausted
    expect(r?.needsNormalization).toBe(true);
  });
});
