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

describe("childProgressByParent — leaf status roll-up", () => {
  it("aggregates a parent's direct children into a status mix (3/5 完了)", () => {
    const rows = [row("p", null), row("c1", "p"), row("c2", "p"), row("c3", "p"), row("c4", "p"), row("c5", "p")];
    const st = statuses({ c1: "done", c2: "done", c3: "done", c4: "in_progress", c5: "todo" });
    const prog = childProgressByParent(rows, st).get("p")!;
    expect(prog.total).toBe(5);
    expect(prog.doneCount).toBe(3);
    expect(prog.inProgressCount).toBe(1);
    expect(prog.todoCount).toBe(1);
    expect(prog.donePercent).toBe(60);
  });

  it("orders segments done → in_progress → blocked → todo → cancelled and fractions sum to 1", () => {
    const rows = [row("p", null), row("a", "p"), row("b", "p"), row("c", "p"), row("d", "p")];
    const prog = childProgressByParent(rows, statuses({ a: "todo", b: "done", c: "blocked", d: "in_progress" })).get(
      "p",
    )!;
    expect(prog.segments.map((s) => s.status)).toEqual(["done", "in_progress", "blocked", "todo"]);
    expect(prog.segments.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1);
  });

  it("omits leaf rows (no children) from the result", () => {
    const rows = [row("p", null), row("c1", "p")];
    const map = childProgressByParent(rows, statuses({ p: "in_progress", c1: "done" }));
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

  it("A PARENT'S OWN stored status column is never counted — only its descendant leaves are", () => {
    // The parent's own `status` field can be anything (stale/irrelevant); the roll-up
    // must aggregate purely from the leaves underneath it.
    const rows = [row("p", null), row("c1", "p"), row("c2", "p")];
    const prog = childProgressByParent(rows, statuses({ p: "cancelled", c1: "done", c2: "done" })).get("p")!;
    expect(prog.total).toBe(2); // NOT 3 — the parent's own row is not a leaf unit
    expect(prog.doneCount).toBe(2);
    expect(prog.donePercent).toBe(100);
  });
});

describe("childProgressByParent — recursive multi-level aggregation (何階層でも)", () => {
  // root -> mid -> {leaf1, leaf2, leaf3} ; a 3-level WBS.
  const threeLevel = [
    row("root", null),
    row("mid", "root"),
    row("leaf1", "mid"),
    row("leaf2", "mid"),
    row("leaf3", "mid"),
  ];

  it("a grandparent (2 levels up) aggregates its grandchildren's leaf statuses, not just its direct child's own status", () => {
    const st = statuses({ leaf1: "done", leaf2: "done", leaf3: "blocked" });
    const map = childProgressByParent(threeLevel, st);

    const mid = map.get("mid")!;
    expect(mid.total).toBe(3);
    expect(mid.doneCount).toBe(2);
    expect(mid.blockedCount).toBe(1);

    // root has only ONE direct child ("mid"), yet its roll-up must reflect the THREE
    // leaves under mid — proof the aggregation is recursive, not capped at depth 1.
    const root = map.get("root")!;
    expect(root.total).toBe(3);
    expect(root.doneCount).toBe(2);
    expect(root.blockedCount).toBe(1);
    expect(root.donePercent).toBe(mid.donePercent);
  });

  it("propagates a leaf status change all the way to the top-level ancestor", () => {
    const before = childProgressByParent(threeLevel, statuses({ leaf1: "todo", leaf2: "todo", leaf3: "todo" })).get(
      "root",
    )!;
    expect(before.doneCount).toBe(0);

    const after = childProgressByParent(threeLevel, statuses({ leaf1: "done", leaf2: "todo", leaf3: "todo" })).get(
      "root",
    )!;
    expect(after.doneCount).toBe(1);
    expect(after.total).toBe(3);
  });

  it("handles 4+ levels (great-grandparent) with mixed branches", () => {
    // top -> a -> {b (-> leaf1, leaf2), c (leaf, direct child of a)}
    const rows = [
      row("top", null),
      row("a", "top"),
      row("b", "a"),
      row("c", "a"),
      row("leaf1", "b"),
      row("leaf2", "b"),
    ];
    const st = statuses({ c: "done", leaf1: "done", leaf2: "in_progress" });
    const map = childProgressByParent(rows, st);
    // b: direct leaves leaf1(done)+leaf2(in_progress)
    expect(map.get("b")!.total).toBe(2);
    expect(map.get("b")!.doneCount).toBe(1);
    // a: descendants are c(done, itself a leaf) + leaf1(done) + leaf2(in_progress) = 3
    expect(map.get("a")!.total).toBe(3);
    expect(map.get("a")!.doneCount).toBe(2);
    expect(map.get("a")!.inProgressCount).toBe(1);
    // top: same 3 leaves, one level further up
    expect(map.get("top")!.total).toBe(3);
    expect(map.get("top")!.doneCount).toBe(2);
  });
});

describe("childProgressByParent — dominantStatus (最多=プルラリティ) + tie-break", () => {
  it("picks the status with the largest share as dominantStatus", () => {
    const rows = [row("p", null), row("c1", "p"), row("c2", "p"), row("c3", "p")];
    const prog = childProgressByParent(rows, statuses({ c1: "done", c2: "done", c3: "todo" })).get("p")!;
    expect(prog.dominantStatus).toBe("done");
  });

  it("recomputes dominantStatus recursively for a multi-level ancestor", () => {
    const rows = [row("root", null), row("mid", "root"), row("l1", "mid"), row("l2", "mid"), row("l3", "mid")];
    const prog = childProgressByParent(rows, statuses({ l1: "blocked", l2: "blocked", l3: "done" })).get("root")!;
    expect(prog.dominantStatus).toBe("blocked");
  });

  it("tie-break: on an equal count, prefers 未完了寄り in order blocked > in_progress > todo > cancelled > done", () => {
    const rows = [row("p", null), row("c1", "p"), row("c2", "p")];

    // done vs todo tie (1 each) -> todo wins (todo ranks above done in the tie order)
    expect(childProgressByParent(rows, statuses({ c1: "done", c2: "todo" })).get("p")!.dominantStatus).toBe("todo");

    // blocked vs in_progress tie -> blocked wins
    expect(
      childProgressByParent(rows, statuses({ c1: "in_progress", c2: "blocked" })).get("p")!.dominantStatus,
    ).toBe("blocked");

    // in_progress vs todo tie -> in_progress wins
    expect(
      childProgressByParent(rows, statuses({ c1: "todo", c2: "in_progress" })).get("p")!.dominantStatus,
    ).toBe("in_progress");

    // cancelled vs done tie -> cancelled wins (done is last in the tie order)
    expect(
      childProgressByParent(rows, statuses({ c1: "done", c2: "cancelled" })).get("p")!.dominantStatus,
    ).toBe("cancelled");
  });

  it("a clean sweep (all leaves done) makes dominantStatus done", () => {
    const rows = [row("p", null), row("c1", "p"), row("c2", "p")];
    const prog = childProgressByParent(rows, statuses({ c1: "done", c2: "done" })).get("p")!;
    expect(prog.dominantStatus).toBe("done");
  });
});
