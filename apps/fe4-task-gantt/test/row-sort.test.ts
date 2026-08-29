import { describe, it, expect } from "vitest";
import type { common, gantt, task } from "@dub/types";
import { sortRows, sortRowsMulti, type SortContext } from "../src/domain/row-sort";

// Minimal row factory. Sorting reads taskId + parentTaskId (+ dates for schedule).
function row(
  id: string,
  parent: string | null = null,
  dates?: { start?: string | null; end?: string | null },
): gantt.GanttRow {
  return {
    taskId: id as common.TaskId,
    title: id,
    startsAt: (dates?.start ?? null) as common.ISODateTime | null,
    endsAt: (dates?.end ?? null) as common.ISODateTime | null,
    progressPercent: 0,
    assigneeId: null,
    parentTaskId: (parent as common.TaskId | null) ?? null,
    depth: parent ? 1 : 0,
    hasChildren: false,
  };
}
const ids = (rows: gantt.GanttRow[]) => rows.map((r) => r.taskId);

function ctx(over: Partial<SortContext> = {}): SortContext {
  return {
    priorityById: new Map(),
    teamIdById: new Map(),
    teamOrder: new Map(),
    ...over,
  };
}

describe("sortRows — manual passthrough", () => {
  it("returns the input unchanged in manual mode", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(ids(sortRows(rows, "manual", ctx()))).toEqual(["a", "b", "c"]);
  });
});

describe("sortRows — priority (重要度順)", () => {
  const prio = (m: Record<string, task.TaskPriority>): SortContext =>
    ctx({ priorityById: new Map(Object.entries(m) as [common.TaskId, task.TaskPriority][]) });

  it("orders urgent → high → medium → low", () => {
    const rows = [row("low"), row("urgent"), row("medium"), row("high")];
    const c = prio({ low: "low", urgent: "urgent", medium: "medium", high: "high" });
    expect(ids(sortRows(rows, "priority", c))).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("defaults missing priority to medium and is stable on ties", () => {
    // a (unset→medium), b (high), c (unset→medium): high first, then a,c in orig order
    const rows = [row("a"), row("b"), row("c")];
    const c = prio({ b: "high" });
    expect(ids(sortRows(rows, "priority", c))).toEqual(["b", "a", "c"]);
  });

  it("only re-sorts within a sibling group (parent→children contiguity kept)", () => {
    // p1 has children c1,c2; p2 has child c3. Parents sorted by priority; children stay under their parent.
    const rows = [
      row("p1"),
      row("c1", "p1"),
      row("c2", "p1"),
      row("p2"),
      row("c3", "p2"),
    ];
    const c = prio({ p1: "low", p2: "urgent", c1: "low", c2: "high" });
    // p2 (urgent) before p1 (low); within p1, c2 (high) before c1 (low)
    expect(ids(sortRows(rows, "priority", c))).toEqual(["p2", "c3", "p1", "c2", "c1"]);
  });
});

describe("sortRows — schedule (時期が早い順)", () => {
  it("orders by start date ascending, dateless last", () => {
    const rows = [
      row("late", null, { start: "2026-03-01T00:00:00.000Z" }),
      row("none"),
      row("early", null, { start: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(ids(sortRows(rows, "schedule", ctx()))).toEqual(["early", "late", "none"]);
  });

  it("falls back to the due edge (endsAt) when startsAt is absent", () => {
    const rows = [
      row("dueLate", null, { end: "2026-05-01T00:00:00.000Z" }),
      row("dueEarly", null, { end: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(ids(sortRows(rows, "schedule", ctx()))).toEqual(["dueEarly", "dueLate"]);
  });

  it("a dateless parent sorts by the EARLIEST date in its subtree", () => {
    // p1 has no own date but a child starting Jan; p2 starts Feb → p1 sorts first.
    const rows = [
      row("p2", null, { start: "2026-02-01T00:00:00.000Z" }),
      row("p1"),
      row("c1", "p1", { start: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(ids(sortRows(rows, "schedule", ctx()))).toEqual(["p1", "c1", "p2"]);
  });
});

describe("sortRows — team (チーム順)", () => {
  it("orders by the member-service team order, team-less last", () => {
    const rows = [row("b"), row("none"), row("a")];
    const c = ctx({
      teamIdById: new Map([
        ["a", "team-b"],
        ["b", "team-a"],
      ] as [common.TaskId, common.TeamId][]),
      teamOrder: new Map([
        ["team-a", 0],
        ["team-b", 1],
      ] as [common.TeamId, number][]),
    });
    // team-a (rank 0) row "b" first, then team-b row "a", then team-less "none"
    expect(ids(sortRows(rows, "team", c))).toEqual(["b", "a", "none"]);
  });
});

describe("sortRows — safety", () => {
  it("never drops a row whose parent is outside the set", () => {
    const rows = [row("orphan", "missing-parent"), row("a")];
    const out = sortRows(rows, "priority", ctx());
    expect(out.length).toBe(2);
    expect(new Set(ids(out))).toEqual(new Set(["orphan", "a"]));
  });

  it("returns [] for empty input", () => {
    expect(sortRows([], "priority", ctx())).toEqual([]);
  });
});

describe("sortRowsMulti — 多段（複数キー）composition", () => {
  const prio = (m: Record<string, task.TaskPriority>) =>
    new Map(Object.entries(m) as [common.TaskId, task.TaskPriority][]);
  const teamOf = (m: Record<string, string>) =>
    new Map(Object.entries(m) as [common.TaskId, common.TeamId][]);

  it("empty spec list returns the input unchanged", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(ids(sortRowsMulti(rows, [], ctx()))).toEqual(["a", "b", "c"]);
  });

  it("applies チーム → 重要度 → 時期 in priority order (each breaks the previous's ties)", () => {
    const rows = [
      row("A"), // team-b, high, no date
      row("B"), // team-a, low, no date
      row("C", null, { start: "2026-01-01T00:00:00Z" }), // team-a, high, early
      row("D", null, { start: "2026-02-01T00:00:00Z" }), // team-a, high, late
    ];
    const c = ctx({
      priorityById: prio({ A: "high", B: "low", C: "high", D: "high" }),
      teamIdById: teamOf({ A: "team-b", B: "team-a", C: "team-a", D: "team-a" }),
      teamOrder: new Map([
        ["team-a", 0],
        ["team-b", 1],
      ] as [common.TeamId, number][]),
    });
    const out = sortRowsMulti(
      rows,
      [
        { key: "team", dir: "asc" },
        { key: "priority", dir: "asc" },
        { key: "schedule", dir: "asc" },
      ],
      c,
    );
    // team-a first: high(C,D) before low(B); C before D by earlier date. Then team-b: A.
    expect(ids(out)).toEqual(["C", "D", "B", "A"]);
  });

  it("honors per-key direction (重要度 降順 puts low before high)", () => {
    const rows = [row("hi"), row("lo")];
    const c = ctx({ priorityById: prio({ hi: "high", lo: "low" }) });
    expect(ids(sortRowsMulti(rows, [{ key: "priority", dir: "asc" }], c))).toEqual(["hi", "lo"]);
    expect(ids(sortRowsMulti(rows, [{ key: "priority", dir: "desc" }], c))).toEqual(["lo", "hi"]);
  });

  it("a single ascending spec equals the single-key sortRows (superset)", () => {
    const rows = [row("a"), row("b"), row("c")];
    const c = ctx({ priorityById: prio({ a: "low", b: "urgent", c: "medium" }) });
    expect(ids(sortRowsMulti(rows, [{ key: "priority", dir: "asc" }], c))).toEqual(
      ids(sortRows(rows, "priority", c)),
    );
  });

  it("preserves WBS contiguity: only re-sorts within each sibling group", () => {
    // p1 (team-b) with children c1,c2 ; p2 (team-a) with child c3
    const rows = [
      row("p1"),
      row("c1", "p1"),
      row("c2", "p1"),
      row("p2"),
      row("c3", "p2"),
    ];
    const c = ctx({
      teamIdById: teamOf({ p1: "team-b", c1: "team-b", c2: "team-b", p2: "team-a", c3: "team-a" }),
      priorityById: prio({ c1: "low", c2: "urgent" }),
      teamOrder: new Map([
        ["team-a", 0],
        ["team-b", 1],
      ] as [common.TeamId, number][]),
    });
    const out = ids(
      sortRowsMulti(
        rows,
        [
          { key: "team", dir: "asc" },
          { key: "priority", dir: "asc" },
        ],
        c,
      ),
    );
    // p2 (team-a) moves ahead of p1 (team-b); each parent keeps its own children block.
    expect(out).toEqual(["p2", "c3", "p1", "c2", "c1"]);
  });
});
