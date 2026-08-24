import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import {
  computeTaskNumbers,
  clampPadWidth,
  DEFAULT_PAD_WIDTH,
  MAX_PAD_WIDTH,
} from "../src/domain/task-number";

// Row helper: `createdAt` fixes the creation-order rank; `team` is turned into the
// 2-letter prefix by the resolver passed to computeTaskNumbers.
const row = (
  id: string,
  createdAt: string | null = null,
  team = "",
  idSeqAt: string | null = null,
): gantt.GanttRow => ({
  taskId: id,
  title: id,
  startsAt: null,
  endsAt: null,
  progressPercent: 0,
  assigneeId: null,
  teamId: team || null,
  ...(createdAt ? { createdAt } : {}),
  ...(idSeqAt ? { idSeqAt } : {}),
});

// Trivial resolver: the row's teamId IS the code (upper-cased) for these unit tests.
const codeOf = (r: gantt.GanttRow) => (r.teamId ?? "").toUpperCase();

describe("computeTaskNumbers — global creation-order + team prefix", () => {
  it("numbers by creation order (createdAt), prefixed by team", () => {
    const rows = [
      row("a", "2026-01-01T00:00:00Z", "tk"),
      row("b", "2026-01-02T00:00:00Z", "sp"),
      row("c", "2026-01-03T00:00:00Z", "tk"),
    ];
    const n = computeTaskNumbers(rows, codeOf);
    expect(n.get("a")).toBe("TK-1");
    expect(n.get("b")).toBe("SP-2");
    expect(n.get("c")).toBe("TK-3");
  });

  it("is INDEPENDENT of the incoming row order (stable under sort/filter)", () => {
    const rows = [
      row("a", "2026-01-01T00:00:00Z", "tk"),
      row("b", "2026-01-02T00:00:00Z", "sp"),
      row("c", "2026-01-03T00:00:00Z", "hk"),
    ];
    const forward = computeTaskNumbers(rows, codeOf);
    const shuffled = computeTaskNumbers([rows[2]!, rows[0]!, rows[1]!], codeOf);
    // Same numbers regardless of display order — this is the stability property.
    for (const id of ["a", "b", "c"]) expect(shuffled.get(id)).toBe(forward.get(id));
    expect(forward.get("a")).toBe("TK-1");
    expect(forward.get("c")).toBe("HK-3");
  });

  it("filtering out rows keeps each remaining task's GLOBAL number", () => {
    const all = [
      row("a", "2026-01-01T00:00:00Z", "tk"),
      row("b", "2026-01-02T00:00:00Z", "sp"),
      row("c", "2026-01-03T00:00:00Z", "tk"),
    ];
    const full = computeTaskNumbers(all, codeOf);
    // The caller computes over the FULL set, then looks up displayed rows — so a
    // team filter that shows only "tk" tasks still reads TK-1 / TK-3 (not renumbered).
    expect(full.get("a")).toBe("TK-1");
    expect(full.get("c")).toBe("TK-3");
  });

  it("idSeqAt overrides createdAt → team change moves a task to the tail", () => {
    const rows = [
      row("a", "2026-01-01T00:00:00Z", "tk"),
      // 'b' was created 2nd but its team changed later (idSeqAt bumped) → now tail,
      // renumbered under its new team code.
      row("b", "2026-01-02T00:00:00Z", "hk", "2026-06-01T00:00:00Z"),
      row("c", "2026-01-03T00:00:00Z", "sp"),
    ];
    const n = computeTaskNumbers(rows, codeOf);
    expect(n.get("a")).toBe("TK-1");
    expect(n.get("c")).toBe("SP-2");
    expect(n.get("b")).toBe("HK-3"); // retired old ID; re-numbered at the tail
  });

  it("deterministic tie-break by taskId when the basis is equal/absent", () => {
    const n = computeTaskNumbers([row("b"), row("a"), row("c")], codeOf);
    expect(n.get("a")).toBe("1");
    expect(n.get("b")).toBe("2");
    expect(n.get("c")).toBe("3");
  });

  it("omits the prefix for a team-less (unresolvable) row", () => {
    const n = computeTaskNumbers([row("a", "2026-01-01T00:00:00Z", "")], codeOf);
    expect(n.get("a")).toBe("1");
  });
});

describe("computeTaskNumbers — zero padding", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row(`t${String(i).padStart(2, "0")}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, "tk"),
  );

  it("zero-pads the number to a fixed width (4 -> TK-0001)", () => {
    const n = computeTaskNumbers(rows, codeOf, 4);
    expect(n.get("t00")).toBe("TK-0001");
    expect(n.get("t11")).toBe("TK-0012");
  });

  it("does not truncate a number longer than the pad width", () => {
    const n = computeTaskNumbers(rows, codeOf, 2);
    expect(n.get("t00")).toBe("TK-01");
    expect(n.get("t11")).toBe("TK-12");
  });

  it("width 0 or 1 leaves the number unpadded", () => {
    const one = [row("a", "2026-01-01T00:00:00Z", "tk")];
    expect(computeTaskNumbers(one, codeOf, 0).get("a")).toBe("TK-1");
    expect(computeTaskNumbers(one, codeOf, 1).get("a")).toBe("TK-1");
  });

  it("padding works with no prefix (bare padded number)", () => {
    const n = computeTaskNumbers([row("a", "2026-01-01T00:00:00Z", "")], codeOf, 3);
    expect(n.get("a")).toBe("001");
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
