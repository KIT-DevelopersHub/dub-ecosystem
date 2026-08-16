import { describe, expect, it } from "vitest";
import { ariaLevel, childrenQueryKey, nextFocusIndex, toggleExpanded } from "./tree.ts";

describe("toggleExpanded", () => {
  it("adds an id that is not present and returns a new set", () => {
    const start = new Set<string>();
    const next = toggleExpanded(start, "fld_root");
    expect(next.has("fld_root")).toBe(true);
    expect(next).not.toBe(start); // immutable
    expect(start.has("fld_root")).toBe(false); // input untouched
  });

  it("removes an id that is already present", () => {
    const next = toggleExpanded(new Set(["fld_root", "fld_designs"]), "fld_root");
    expect(next.has("fld_root")).toBe(false);
    expect(next.has("fld_designs")).toBe(true);
  });
});

describe("childrenQueryKey", () => {
  it("is feature-scoped, distinct per folder, and stable", () => {
    expect(childrenQueryKey("fld_root")).toEqual(["driveshare", "files", "children", "fld_root"]);
    expect(childrenQueryKey("fld_a")).not.toEqual(childrenQueryKey("fld_b"));
  });

  it("does not collide with the root files key shape", () => {
    // root uses ["driveshare","files", <search>]; children insert a "children" segment.
    expect(childrenQueryKey("fld_root")).not.toEqual(["driveshare", "files", "fld_root"]);
  });
});

describe("ariaLevel", () => {
  it("is 1-based (root depth 0 → level 1)", () => {
    expect(ariaLevel(0)).toBe(1);
    expect(ariaLevel(2)).toBe(3);
  });
});

describe("nextFocusIndex", () => {
  it("moves within bounds", () => {
    expect(nextFocusIndex(0, 3, 1)).toBe(1);
    expect(nextFocusIndex(2, 3, -1)).toBe(1);
  });
  it("clamps at both ends (no wrap)", () => {
    expect(nextFocusIndex(0, 3, -1)).toBe(0);
    expect(nextFocusIndex(2, 3, 1)).toBe(2);
  });
  it("returns -1 for an empty list", () => {
    expect(nextFocusIndex(0, 0, 1)).toBe(-1);
  });
});
