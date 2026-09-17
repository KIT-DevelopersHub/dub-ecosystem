import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import {
  computeTaskNumbers,
  sanitizePrefix,
  clampPadWidth,
  DEFAULT_PREFIX,
  DEFAULT_PAD_WIDTH,
  MAX_PAD_WIDTH,
} from "../src/domain/task-number";

const row = (id: string, parentTaskId: string | null = null): gantt.GanttRow => ({
  taskId: id,
  title: id,
  startsAt: null,
  endsAt: null,
  progressPercent: 0,
  assigneeId: null,
  ...(parentTaskId ? { parentTaskId } : {}),
});

describe("computeTaskNumbers", () => {
  it("numbers a flat list AA-1, AA-2, AA-3 by display order", () => {
    const n = computeTaskNumbers([row("a"), row("b"), row("c")], "AA");
    expect(n.get("a")).toBe("AA-1");
    expect(n.get("b")).toBe("AA-2");
    expect(n.get("c")).toBe("AA-3");
  });

  it("nests children as parent-number + sibling index (AA-1-1, AA-1-2, AA-2)", () => {
    const rows = [
      row("p1"),
      row("c1", "p1"),
      row("c2", "p1"),
      row("p2"),
      row("c3", "p2"),
    ];
    const n = computeTaskNumbers(rows, "AA");
    expect(n.get("p1")).toBe("AA-1");
    expect(n.get("c1")).toBe("AA-1-1");
    expect(n.get("c2")).toBe("AA-1-2");
    expect(n.get("p2")).toBe("AA-2");
    expect(n.get("c3")).toBe("AA-2-1");
  });

  it("supports 3+ levels of depth", () => {
    const rows = [row("a"), row("b", "a"), row("c", "b")];
    const n = computeTaskNumbers(rows, "AA");
    expect(n.get("a")).toBe("AA-1");
    expect(n.get("b")).toBe("AA-1-1");
    expect(n.get("c")).toBe("AA-1-1-1");
  });

  it("re-numbers when the order changes (order-dependent WBS)", () => {
    const before = computeTaskNumbers([row("a"), row("b")], "AA");
    const after = computeTaskNumbers([row("b"), row("a")], "AA");
    expect(before.get("a")).toBe("AA-1");
    expect(after.get("a")).toBe("AA-2");
    expect(after.get("b")).toBe("AA-1");
  });

  it("honours a custom prefix and an empty prefix (bare code)", () => {
    expect(computeTaskNumbers([row("a")], "P").get("a")).toBe("P-1");
    expect(computeTaskNumbers([row("a"), row("b", "a")], "").get("b")).toBe("1-1");
  });

  it("falls back to a top-level number for an orphan (parent absent / forward ref)", () => {
    // child listed with a parent that isn't in the row set → treated as top-level
    const n = computeTaskNumbers([row("only", "missing")], "AA");
    expect(n.get("only")).toBe("AA-1");
  });

  it("does not crash on a self-referential parent (cycle-proof)", () => {
    const n = computeTaskNumbers([row("x", "x")], "AA");
    // parent not yet numbered when the row is visited → top-level
    expect(n.get("x")).toBe("AA-1");
  });
});

describe("computeTaskNumbers — per-row prefix (function)", () => {
  const teamRow = (id: string, teamId: string | null, parentTaskId: string | null = null): gantt.GanttRow => ({
    taskId: id,
    title: id,
    startsAt: null,
    endsAt: null,
    progressPercent: 0,
    assigneeId: null,
    ...(teamId ? { teamId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
  });

  it("resolves each row's prefix independently — this is the fix for every team showing AA", () => {
    const rows = [teamRow("a", "team_tk"), teamRow("b", "team_hk"), teamRow("c", "team_se")];
    const codeByTeamId: Record<string, string> = { team_tk: "TK", team_hk: "HK", team_se: "SE" };
    const n = computeTaskNumbers(rows, (r) => codeByTeamId[r.teamId as string] ?? "", 0);
    // Same global sibling sequence as before (1, 2, 3 in display order) — only the
    // PREFIX now varies per row's own team instead of being one shared value.
    expect(n.get("a")).toBe("TK-1");
    expect(n.get("b")).toBe("HK-2");
    expect(n.get("c")).toBe("SE-3");
  });

  it("a team-less row falls back to the bare number when the resolver returns \"\"", () => {
    const n = computeTaskNumbers([teamRow("a", null)], () => "", 0);
    expect(n.get("a")).toBe("1");
  });

  it("keeps per-row prefixes with WBS nesting and zero-padding", () => {
    const rows = [teamRow("p1", "team_tk"), teamRow("c1", "team_hk", "p1")];
    const codeByTeamId: Record<string, string> = { team_tk: "TK", team_hk: "HK" };
    const n = computeTaskNumbers(rows, (r) => codeByTeamId[r.teamId as string] ?? "", 3);
    expect(n.get("p1")).toBe("TK-001");
    expect(n.get("c1")).toBe("HK-001-001");
  });
});

describe("computeTaskNumbers — zero padding", () => {
  it("zero-pads each segment to a fixed width (4 -> AA-0001, AA-0001-0001)", () => {
    const rows = [row("p1"), row("c1", "p1"), row("c2", "p1"), row("p2")];
    const n = computeTaskNumbers(rows, "AA", 4);
    expect(n.get("p1")).toBe("AA-0001");
    expect(n.get("c1")).toBe("AA-0001-0001");
    expect(n.get("c2")).toBe("AA-0001-0002");
    expect(n.get("p2")).toBe("AA-0002");
  });

  it("does not truncate a number longer than the pad width", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`t${i}`));
    const n = computeTaskNumbers(rows, "AA", 2);
    expect(n.get("t0")).toBe("AA-01");
    expect(n.get("t11")).toBe("AA-12");
  });

  it("width 0 or 1 leaves numbers unpadded", () => {
    expect(computeTaskNumbers([row("a")], "AA", 0).get("a")).toBe("AA-1");
    expect(computeTaskNumbers([row("a")], "AA", 1).get("a")).toBe("AA-1");
  });

  it("padding works with an empty prefix (bare padded code)", () => {
    const n = computeTaskNumbers([row("a"), row("b", "a")], "", 3);
    expect(n.get("b")).toBe("001-001");
  });
});

describe("clampPadWidth", () => {
  it("clamps to [0, MAX] and floors", () => {
    expect(clampPadWidth(-2)).toBe(0);
    expect(clampPadWidth(3.9)).toBe(3);
    expect(clampPadWidth(99)).toBe(MAX_PAD_WIDTH);
    expect(clampPadWidth(Number.NaN)).toBe(0);
  });
  it("default pad width is 4", () => {
    expect(DEFAULT_PAD_WIDTH).toBe(4);
  });
});

describe("sanitizePrefix", () => {
  it("strips whitespace and caps length", () => {
    expect(sanitizePrefix("  A B  ")).toBe("AB");
    expect(sanitizePrefix("ABCDEFGHIJK")).toBe("ABCDEFGH");
  });
  it("default prefix is AA", () => {
    expect(DEFAULT_PREFIX).toBe("AA");
  });
});
