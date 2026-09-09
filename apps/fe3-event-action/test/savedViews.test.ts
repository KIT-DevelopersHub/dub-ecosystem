import { describe, it, expect, beforeEach } from "vitest";
import {
  emptySavedViews,
  addView,
  removeView,
  setDefault,
  defaultQuery,
  coerceSavedViews,
  loadSavedViews,
  persistSavedViews,
} from "../src/lib/savedViews";

describe("savedViews pure ops (P2-2)", () => {
  it("adds a view and returns a new state", () => {
    const s = addView(emptySavedViews(), "開催中", "phase=open", { id: "v1", now: 1 });
    expect(s.views).toEqual([{ id: "v1", name: "開催中", query: "phase=open", createdAt: 1 }]);
    expect(s.defaultId).toBeNull();
  });

  it("trims the name and ignores an empty/whitespace name", () => {
    expect(addView(emptySavedViews(), "  x  ", "q", { id: "a" }).views[0]?.name).toBe("x");
    expect(addView(emptySavedViews(), "   ", "q").views).toHaveLength(0);
  });

  it("overwrites the query of a same-named view instead of duplicating", () => {
    const s1 = addView(emptySavedViews(), "A", "phase=open", { id: "v1", now: 1 });
    const s2 = addView(s1, "A", "archived=1", { id: "vX", now: 2 });
    expect(s2.views).toHaveLength(1);
    expect(s2.views[0]).toMatchObject({ id: "v1", query: "archived=1", createdAt: 2 });
  });

  it("makeDefault marks the added view as default", () => {
    const s = addView(emptySavedViews(), "A", "phase=live", { id: "v1", makeDefault: true });
    expect(s.defaultId).toBe("v1");
    expect(defaultQuery(s)).toBe("phase=live");
  });

  it("removeView drops the view and clears a dangling default", () => {
    let s = addView(emptySavedViews(), "A", "q", { id: "v1", makeDefault: true });
    s = addView(s, "B", "phase=open", { id: "v2" });
    s = removeView(s, "v1");
    expect(s.views.map((v) => v.id)).toEqual(["v2"]);
    expect(s.defaultId).toBeNull();
  });

  it("setDefault ignores unknown ids and can clear with null", () => {
    let s = addView(emptySavedViews(), "A", "q", { id: "v1" });
    expect(setDefault(s, "nope").defaultId).toBeNull();
    s = setDefault(s, "v1");
    expect(s.defaultId).toBe("v1");
    expect(setDefault(s, null).defaultId).toBeNull();
  });

  it("defaultQuery returns null when there is no valid default", () => {
    expect(defaultQuery(emptySavedViews())).toBeNull();
  });

  it("coerce drops garbage rows and a dangling defaultId", () => {
    const s = coerceSavedViews({
      views: [
        { id: "v1", name: "ok", query: "phase=open", createdAt: 5 },
        { id: "", name: "no-id", query: "x" },
        { name: "no-id2" },
        "junk",
      ],
      defaultId: "ghost",
    });
    expect(s.views.map((v) => v.id)).toEqual(["v1"]);
    expect(s.defaultId).toBeNull();
  });

  it("coerce returns empty for non-object payloads", () => {
    expect(coerceSavedViews(null)).toEqual(emptySavedViews());
    expect(coerceSavedViews("nope")).toEqual(emptySavedViews());
  });
});

describe("savedViews persistence (localStorage round-trip)", () => {
  beforeEach(() => localStorage.clear());

  it("persist then load round-trips the state", () => {
    let s = addView(emptySavedViews(), "開催中", "phase=open", { id: "v1", makeDefault: true });
    s = addView(s, "アーカイブ込み", "archived=1", { id: "v2" });
    persistSavedViews(s);
    expect(loadSavedViews()).toEqual(s);
  });

  it("load returns empty when nothing is stored", () => {
    expect(loadSavedViews()).toEqual(emptySavedViews());
  });

  it("load tolerates corrupt JSON", () => {
    localStorage.setItem("fe3:event-saved-views", "{not json");
    expect(loadSavedViews()).toEqual(emptySavedViews());
  });
});
