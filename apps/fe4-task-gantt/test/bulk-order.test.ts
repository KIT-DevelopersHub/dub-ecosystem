import { describe, it, expect } from "vitest";
import type { common, gantt } from "@dub/types";
import { moveSelectionVertical, selectionRoots } from "../src/domain/row-order";

// Minimal row factory (only the fields row-order reads: taskId + parentTaskId).
function row(id: string, parent: string | null = null, depth = parent ? 1 : 0): gantt.GanttRow {
  return {
    taskId: id as common.TaskId,
    title: id,
    startsAt: null,
    endsAt: null,
    progressPercent: 0,
    assigneeId: null,
    parentTaskId: (parent as common.TaskId | null) ?? null,
    depth,
    hasChildren: false,
  };
}
const set = (...xs: string[]) => new Set(xs as common.TaskId[]);

describe("moveSelectionVertical", () => {
  it("moves a single selected top-level row up one slot", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(moveSelectionVertical(rows, set("c"), -1)).toEqual(["a", "c", "b"]);
  });

  it("moves a single selected row down one slot", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(moveSelectionVertical(rows, set("a"), 1)).toEqual(["b", "a", "c"]);
  });

  it("slides a contiguous multi-selection up as a block (the neighbour hops below)", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    // select b,c → up → a slides below the block
    expect(moveSelectionVertical(rows, set("b", "c"), -1)).toEqual(["b", "c", "a", "d"]);
  });

  it("keeps a non-contiguous selection's relative order while each hops one slot", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    // select a,c → down → a↔b, c↔d
    expect(moveSelectionVertical(rows, set("a", "c"), 1)).toEqual(["b", "a", "d", "c"]);
  });

  it("returns null when the selection is already at the top edge", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(moveSelectionVertical(rows, set("a"), -1)).toBeNull();
  });

  it("returns null when the selection is already at the bottom edge", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(moveSelectionVertical(rows, set("c"), 1)).toBeNull();
  });

  it("reorders only within each sibling group and preserves parent→children contiguity", () => {
    // p1{p1a,p1b}, p2{p2a}
    const rows = [row("p1"), row("p1a", "p1"), row("p1b", "p1"), row("p2"), row("p2a", "p2")];
    // select p1b → up → swaps with p1a INSIDE p1's group; tree stays linearised
    expect(moveSelectionVertical(rows, set("p1b"), -1)).toEqual(["p1", "p1b", "p1a", "p2", "p2a"]);
  });

  it("moves whole parents (with their children carried by re-linearisation)", () => {
    const rows = [row("p1"), row("p1a", "p1"), row("p2"), row("p2a", "p2")];
    // select p2 (top-level) → up → p2 block before p1 block
    expect(moveSelectionVertical(rows, set("p2"), -1)).toEqual(["p2", "p2a", "p1", "p1a"]);
  });

  it("returns null for an empty selection", () => {
    expect(moveSelectionVertical([row("a")], set(), -1)).toBeNull();
  });
});

describe("selectionRoots", () => {
  it("drops a selected child whose selected parent already carries it", () => {
    const rows = [row("p1"), row("p1a", "p1"), row("p1b", "p1")];
    // both p1 and its child p1a selected → only p1 is a root
    expect(selectionRoots(rows, set("p1", "p1a"))).toEqual(["p1"]);
  });

  it("keeps independent selected rows across different subtrees", () => {
    const rows = [row("p1"), row("p1a", "p1"), row("p2"), row("p2a", "p2")];
    expect(selectionRoots(rows, set("p1a", "p2a"))).toEqual(["p1a", "p2a"]);
  });

  it("drops a deeply-nested descendant of a selected ancestor", () => {
    const rows = [row("p1"), row("c", "p1"), row("g", "c", 2)];
    expect(selectionRoots(rows, set("p1", "g"))).toEqual(["p1"]);
  });

  it("returns every selected id when none are ancestors of another", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(selectionRoots(rows, set("a", "c")).sort()).toEqual(["a", "c"]);
  });
});
