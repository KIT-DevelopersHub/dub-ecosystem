import { describe, it, expect } from "vitest";
import type { common, gantt, task } from "@dub/types";
import { childProgressByParent } from "../src/domain/child-progress";

const row = (id: string, parentTaskId: string | null): gantt.GanttRow => ({
  taskId: id,
  title: id,
  startsAt: "2026-08-01T00:00:00.000Z",
  endsAt: "2026-08-05T00:00:00.000Z",
  progressPercent: 0,
  assigneeId: null,
  parentTaskId,
  depth: parentTaskId ? 1 : 0,
  hasChildren: !parentTaskId,
});

const statuses = (m: Record<string, task.TaskStatus>): ReadonlyMap<common.TaskId, task.TaskStatus> =>
  new Map(Object.entries(m));

describe("childProgressByParent", () => {
  it("aggregates a parent's direct children into a status mix (3/5 完了)", () => {
    const rows = [
      row("p", null),
      row("c1", "p"),
      row("c2", "p"),
      row("c3", "p"),
      row("c4", "p"),
      row("c5", "p"),
    ];
    const st = statuses({
      p: "in_progress",
      c1: "done",
      c2: "done",
      c3: "done",
      c4: "in_progress",
      c5: "todo",
    });
    const prog = childProgressByParent(rows, st).get("p")!;
    expect(prog.total).toBe(5);
    expect(prog.doneCount).toBe(3);
    expect(prog.inProgressCount).toBe(1);
    expect(prog.todoCount).toBe(1);
    expect(prog.donePercent).toBe(60);
  });

  it("orders segments done → in_progress → blocked → todo → cancelled and fractions sum to 1", () => {
    const rows = [row("p", null), row("a", "p"), row("b", "p"), row("c", "p"), row("d", "p")];
    const prog = childProgressByParent(
      rows,
      statuses({ a: "todo", b: "done", c: "blocked", d: "in_progress" }),
    ).get("p")!;
    expect(prog.segments.map((s) => s.status)).toEqual(["done", "in_progress", "blocked", "todo"]);
    expect(prog.segments.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1);
  });

  it("omits leaf rows (no children) from the result", () => {
    const rows = [row("p", null), row("c1", "p")];
    const map = childProgressByParent(rows, statuses({ p: "todo", c1: "done" }));
    expect(map.has("p")).toBe(true);
    expect(map.has("c1")).toBe(false);
  });

  it("defaults a child with no status entry to todo (未着手)", () => {
    const rows = [row("p", null), row("c1", "p"), row("c2", "p")];
    const prog = childProgressByParent(rows, statuses({ c1: "done" })).get("p")!;
    expect(prog.total).toBe(2);
    expect(prog.doneCount).toBe(1);
    expect(prog.todoCount).toBe(1);
    expect(prog.donePercent).toBe(50);
  });

  it("reflects a status change: flipping a child to done raises donePercent", () => {
    const rows = [row("p", null), row("c1", "p"), row("c2", "p")];
    const before = childProgressByParent(rows, statuses({ c1: "in_progress", c2: "done" })).get("p")!;
    const after = childProgressByParent(rows, statuses({ c1: "done", c2: "done" })).get("p")!;
    expect(before.donePercent).toBe(50);
    expect(after.donePercent).toBe(100);
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0]!.status).toBe("done");
  });
});
