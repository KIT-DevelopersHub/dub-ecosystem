import { describe, it, expect } from "vitest";
import { clampBulkResizeDelta, planBulkResize, planBulkResizeFromRows, type BulkResizeRow } from "../src/domain/bulk-resize";
import type { common, gantt } from "@dub/types";

describe("clampBulkResizeDelta", () => {
  it("passes the delta through when no dated leaf is given", () => {
    expect(clampBulkResizeDelta([], "end", 5)).toBe(5);
  });

  it("shrinking the end edge clamps to the tightest (shortest) leaf's floor", () => {
    // durations 5 and 2 days — shrinking by -4 would invert the 2-day task
    // (2 - 4 = -2 < 1), so the shared delta clamps to -(2-1) = -1.
    expect(clampBulkResizeDelta([5, 2], "end", -4)).toBe(-1);
  });

  it("growing the end edge is never clamped", () => {
    expect(clampBulkResizeDelta([5, 2], "end", 10)).toBe(10);
  });

  it("growing the start edge (shrinking via start) clamps to the tightest leaf", () => {
    // moving start forward by +4 would invert the 2-day task; clamps to 2-1=1.
    expect(clampBulkResizeDelta([5, 2], "start", 4)).toBe(1);
  });

  it("moving the start edge earlier (growing) is never clamped", () => {
    expect(clampBulkResizeDelta([5, 2], "start", -10)).toBe(-10);
  });
});

function leaf(id: string, startsAt: string, endsAt: string, parentTaskId: string | null = null): BulkResizeRow {
  return { taskId: id, startsAt, endsAt, parentTaskId, hasChildren: false };
}

describe("planBulkResize — leaves", () => {
  const A = leaf("A", "2026-08-05T00:00:00Z", "2026-08-09T00:00:00Z"); // 4-day span
  const B = leaf("B", "2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"); // 1-day span (tight)

  it("right-edge grow shifts every selected leaf's END by the SAME delta", () => {
    const plan = planBulkResize([A, B], [A, B], ["A", "B"], "end", 3);
    expect(plan.deltaDays).toBe(3);
    const byId = new Map(plan.writes.map((w) => [w.taskId, w]));
    expect(byId.get("A")!.startsAt).toBe(new Date(A.startsAt!).toISOString());
    expect(byId.get("A")!.endsAt).toBe(new Date(Date.parse(A.endsAt!) + 3 * 86_400_000).toISOString());
    expect(byId.get("B")!.endsAt).toBe(new Date(Date.parse(B.endsAt!) + 3 * 86_400_000).toISOString());
  });

  it("right-edge shrink clamps to the 1-day leaf's floor (min-length guard)", () => {
    // Asking for -5 would invert B (1-day span); clamps to 0 (B's own floor: 1 - 1 = 0).
    const plan = planBulkResize([A, B], [A, B], ["A", "B"], "end", -5);
    expect(plan.deltaDays).toBe(0);
    expect(plan.writes).toEqual([]); // nothing moves — B was already at the floor
  });

  it("left-edge shift moves START, leaves END untouched", () => {
    const plan = planBulkResize([A, B], [A, B], ["A", "B"], "start", -2);
    const byId = new Map(plan.writes.map((w) => [w.taskId, w]));
    expect(byId.get("A")!.endsAt).toBe(new Date(A.endsAt!).toISOString());
    expect(byId.get("A")!.startsAt).toBe(new Date(Date.parse(A.startsAt!) - 2 * 86_400_000).toISOString());
  });

  it("skips undated rows", () => {
    const undated: BulkResizeRow = { taskId: "U", startsAt: null, endsAt: null };
    const plan = planBulkResize([A, undated], [A, undated], ["A", "U"], "end", 2);
    expect(plan.writes.map((w) => w.taskId)).toEqual(["A"]);
  });
});

describe("planBulkResize — parents (scale children, not the parent's own row)", () => {
  const c1 = leaf("c1", "2026-08-05T00:00:00Z", "2026-08-09T00:00:00Z", "p");
  const c2 = leaf("c2", "2026-08-15T00:00:00Z", "2026-08-22T00:00:00Z", "p");
  const parent: BulkResizeRow = { taskId: "p", startsAt: null, endsAt: null, hasChildren: true };
  const rolledParent: BulkResizeRow = { taskId: "p", startsAt: c1.startsAt, endsAt: c2.endsAt, hasChildren: true };

  it("scales descendants instead of writing the parent's own (discarded) row", () => {
    const plan = planBulkResize([parent, c1, c2], [rolledParent, c1, c2], ["p"], "end", 3);
    const ids = plan.writes.map((w) => w.taskId);
    expect(ids).not.toContain("p"); // never write the parent's own row
    expect(ids.sort()).toEqual(["c1", "c2"]);
  });

  it("mixing a leaf root and a parent root scales each independently", () => {
    const A = leaf("A", "2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z");
    const plan = planBulkResize([parent, c1, c2, A], [rolledParent, c1, c2, A], ["p", "A"], "end", 2);
    const byId = new Map(plan.writes.map((w) => [w.taskId, w]));
    expect(byId.get("A")!.endsAt).toBe(new Date(Date.parse(A.endsAt!) + 2 * 86_400_000).toISOString());
    expect(byId.has("c1") || byId.has("c2")).toBe(true);
    expect(byId.has("p")).toBe(false);
  });
});

function ganttRow(id: string, startsAt: string | null, endsAt: string | null, opts: Partial<gantt.GanttRow> = {}): gantt.GanttRow {
  return {
    taskId: id as common.TaskId,
    title: id,
    startsAt,
    endsAt,
    progressPercent: 0,
    assigneeId: null,
    parentTaskId: null,
    depth: 0,
    hasChildren: false,
    ...opts,
  };
}

describe("planBulkResizeFromRows", () => {
  it("rolls the rows up itself before planning (integration convenience)", () => {
    const rows: gantt.GanttRow[] = [
      ganttRow("p", null, null, { hasChildren: true }),
      ganttRow("c1", "2026-08-05T00:00:00Z", "2026-08-09T00:00:00Z", { parentTaskId: "p" as common.TaskId, depth: 1 }),
      ganttRow("c2", "2026-08-15T00:00:00Z", "2026-08-22T00:00:00Z", { parentTaskId: "p" as common.TaskId, depth: 1 }),
    ];
    const plan = planBulkResizeFromRows(rows, ["p"], "end", 3);
    expect(plan.writes.map((w) => w.taskId).sort()).toEqual(["c1", "c2"]);
  });
});
