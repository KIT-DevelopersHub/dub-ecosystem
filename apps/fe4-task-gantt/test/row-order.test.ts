import { describe, it, expect } from "vitest";
import type { common, gantt } from "@dub/types";
import { applyManualOrder, reorderWithinSiblings } from "../src/domain/row-order";

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
const ids = (rows: gantt.GanttRow[]) => rows.map((r) => r.taskId);

describe("applyManualOrder", () => {
  it("returns the input order when the overlay is empty", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(ids(applyManualOrder(rows, []))).toEqual(["a", "b", "c"]);
  });

  it("re-sorts top-level rows by the manual overlay", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(ids(applyManualOrder(rows, ["c", "a", "b"] as common.TaskId[]))).toEqual(["c", "a", "b"]);
  });

  it("keeps unlisted ids after listed ones, in their original relative order", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    // only c is pinned first; a,b,d keep their order after it
    expect(ids(applyManualOrder(rows, ["c"] as common.TaskId[]))).toEqual(["c", "a", "b", "d"]);
  });

  it("preserves parent→children contiguity (children move with their parent)", () => {
    // server order: p1, p1c1, p1c2, p2, p2c1
    const rows = [row("p1"), row("p1c1", "p1"), row("p1c2", "p1"), row("p2"), row("p2c1", "p2")];
    // put p2 before p1: its child block must follow it, and p1's block stays intact
    const out = ids(applyManualOrder(rows, ["p2", "p1"] as common.TaskId[]));
    expect(out).toEqual(["p2", "p2c1", "p1", "p1c1", "p1c2"]);
  });

  it("re-orders siblings within a parent group", () => {
    const rows = [row("p"), row("c1", "p"), row("c2", "p"), row("c3", "p")];
    const out = ids(applyManualOrder(rows, ["c3", "c1"] as common.TaskId[]));
    expect(out).toEqual(["p", "c3", "c1", "c2"]);
  });

  it("is idempotent (applying the produced order again is a no-op)", () => {
    const rows = [row("a"), row("b"), row("c")];
    const once = applyManualOrder(rows, ["c", "a", "b"] as common.TaskId[]);
    const twice = applyManualOrder(once, ["c", "a", "b"] as common.TaskId[]);
    expect(ids(twice)).toEqual(ids(once));
  });
});

describe("reorderWithinSiblings", () => {
  const rows = [row("a"), row("b"), row("c"), row("d")];

  it("moves a row to sit before a later sibling", () => {
    // drag d before b -> a, d, b, c
    expect(reorderWithinSiblings(rows, "d" as common.TaskId, "b" as common.TaskId)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves a row to the end when beforeTaskId is null", () => {
    expect(reorderWithinSiblings(rows, "a" as common.TaskId, null)).toEqual(["b", "c", "d", "a"]);
  });

  it("refuses a cross-parent drop (returns null)", () => {
    const tree = [row("p1"), row("c1", "p1"), row("p2"), row("c2", "p2")];
    // dragging c1 (parent p1) onto c2 (parent p2) is a re-parent, not a reorder
    expect(reorderWithinSiblings(tree, "c1" as common.TaskId, "c2" as common.TaskId)).toBeNull();
  });

  it("returns a full-order list that only permutes the affected sibling group", () => {
    const tree = [row("p1"), row("c1", "p1"), row("c2", "p1"), row("p2")];
    // reorder p1's children: c2 before c1. Roots (p1,p2) untouched.
    const out = reorderWithinSiblings(tree, "c2" as common.TaskId, "c1" as common.TaskId);
    expect(out).toEqual(["p1", "c2", "c1", "p2"]);
  });

  it("returns null for a no-op (drop on itself)", () => {
    expect(reorderWithinSiblings(rows, "b" as common.TaskId, "b" as common.TaskId)).toBeNull();
  });
});
