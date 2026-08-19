import { describe, it, expect } from "vitest";
import type { common, gantt } from "@dub/types";
import { groupRuns, type RowGroup } from "../src/domain/row-groups";

// Minimal row factory — groupRuns only reads taskId (order comes from the array).
function row(id: string): gantt.GanttRow {
  return {
    taskId: id as common.TaskId,
    title: id,
    startsAt: null,
    endsAt: null,
    progressPercent: 0,
    assigneeId: null,
    parentTaskId: null,
    depth: 0,
    hasChildren: false,
  };
}
const map = (entries: [string, RowGroup][]) =>
  new Map(entries.map(([id, g]) => [id as common.TaskId, g] as const));

describe("groupRuns", () => {
  it("returns [] when no group map is given", () => {
    expect(groupRuns([row("a"), row("b")], undefined)).toEqual([]);
  });

  it("returns [] for an empty group map", () => {
    expect(groupRuns([row("a")], new Map())).toEqual([]);
  });

  it("collapses contiguous same-key rows into one run with its range", () => {
    const rows = [row("a"), row("b"), row("c"), row("d"), row("e")];
    const g = map([
      ["a", { key: "t1", label: "統括", color: "#f00" }],
      ["b", { key: "t1", label: "統括", color: "#f00" }],
      ["c", { key: "t1", label: "統括", color: "#f00" }],
      ["d", { key: "t2", label: "開発", color: "#0f0" }],
      ["e", { key: "t2", label: "開発", color: "#0f0" }],
    ]);
    const runs = groupRuns(rows, g);
    expect(runs).toEqual([
      { key: "t1", label: "統括", color: "#f00", startIndex: 0, length: 3 },
      { key: "t2", label: "開発", color: "#0f0", startIndex: 3, length: 2 },
    ]);
  });

  it("starts a NEW run when the same key reappears non-contiguously", () => {
    const rows = [row("a"), row("b"), row("c")];
    const g = map([
      ["a", { key: "t1", label: "A" }],
      ["b", { key: "t2", label: "B" }],
      ["c", { key: "t1", label: "A" }],
    ]);
    const runs = groupRuns(rows, g);
    expect(runs.map((r) => [r.key, r.startIndex, r.length])).toEqual([
      ["t1", 0, 1],
      ["t2", 1, 1],
      ["t1", 2, 1],
    ]);
  });

  it("un-mapped rows break a run and are not bracketed", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    const g = map([
      ["a", { key: "t1", label: "A" }],
      // b has no entry
      ["c", { key: "t1", label: "A" }],
      ["d", { key: "t1", label: "A" }],
    ]);
    const runs = groupRuns(rows, g);
    expect(runs).toEqual([
      { key: "t1", label: "A", startIndex: 0, length: 1 },
      { key: "t1", label: "A", startIndex: 2, length: 2 },
    ]);
  });

  it("omits an absent color rather than emitting color: undefined", () => {
    const runs = groupRuns([row("a")], map([["a", { key: "k", label: "L" }]]));
    expect(runs[0]).toEqual({ key: "k", label: "L", startIndex: 0, length: 1 });
    expect("color" in runs[0]!).toBe(false);
  });
});
