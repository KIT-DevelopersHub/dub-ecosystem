import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { buildGanttChartDTO, progressOf, durationDaysOf } from "../src/dto";

function mkTask(over: Partial<task.Task> & { id: string }): task.Task {
  return {
    id: over.id,
    eventId: over.eventId ?? "event_1",
    title: over.title ?? over.id,
    description: null,
    status: over.status ?? "todo",
    priority: over.priority ?? "medium",
    assigneeId: over.assigneeId ?? null,
    teamId: over.teamId ?? null,
    parentTaskId: over.parentTaskId ?? null,
    wbs: over.wbs ?? null,
    startAt: over.startAt ?? null,
    dueAt: over.dueAt ?? null,
    origin: "internal",
    archivedAt: over.archivedAt ?? null,
    createdAt: over.createdAt ?? "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    version: 1,
  };
}
const dep = (taskId: string, dependsOnId: string): task.TaskDependency => ({ taskId, dependsOnId });

describe("progressOf", () => {
  it("done=100, everything else=0", () => {
    expect(progressOf("done")).toBe(100);
    for (const s of ["todo", "in_progress", "blocked", "cancelled"] as const) expect(progressOf(s)).toBe(0);
  });
});

describe("durationDaysOf", () => {
  it("scales by priority (urgent shortest, low longest)", () => {
    expect(durationDaysOf("urgent")).toBe(1);
    expect(durationDaysOf("medium")).toBe(3);
    expect(durationDaysOf("low")).toBe(5);
  });
});

describe("buildGanttChartDTO", () => {
  it("deadline-anchors a bar: endsAt=dueAt, startsAt=dueAt-durationDays", () => {
    const dto = buildGanttChartDTO(
      "event_1",
      [mkTask({ id: "task_a", dueAt: "2026-08-10T00:00:00Z", status: "done", assigneeId: "user_x" })],
      [],
    );
    expect(dto.eventId).toBe("event_1");
    // medium priority => 3-day bar ending on the due date.
    expect(dto.rows).toEqual([
      {
        taskId: "task_a",
        title: "task_a",
        startsAt: "2026-08-07T00:00:00.000Z",
        endsAt: "2026-08-10T00:00:00Z",
        progressPercent: 100,
        assigneeId: "user_x",
        // additive WBS/team projection (flat task ⇒ no team, top-level, no children).
        teamId: null,
        // stable creation-order basis for the task-ID number (projected from the task).
        createdAt: "2026-08-01T00:00:00Z",
        parentTaskId: null,
        depth: 0,
        hasChildren: false,
      },
    ]);
    expect(dto.criticalTaskIds).toEqual(["task_a"]); // single zero-slack task
  });

  it("derives bars for dueAt-less tasks via CPM (dependency order pushes the successor)", () => {
    const dto = buildGanttChartDTO(
      "event_1",
      [mkTask({ id: "task_a" }), mkTask({ id: "task_b" })],
      [dep("task_b", "task_a")], // b depends on a (a=predecessor)
    );
    const a = dto.rows.find((r) => r.taskId === "task_a")!;
    const b = dto.rows.find((r) => r.taskId === "task_b")!;
    // anchor = min createdAt day (2026-08-01); medium duration = 3.
    expect(a.startsAt).toBe("2026-08-01T00:00:00.000Z");
    expect(a.endsAt).toBe("2026-08-04T00:00:00.000Z");
    // b starts when a finishes (FS).
    expect(b.startsAt).toBe("2026-08-04T00:00:00.000Z");
    expect(b.endsAt).toBe("2026-08-07T00:00:00.000Z");
    expect(dto.criticalTaskIds).toEqual(expect.arrayContaining(["task_a", "task_b"]));
  });

  it("degrades gracefully on a dependency cycle (no throw; bars fall back to null)", () => {
    const dto = buildGanttChartDTO(
      "event_1",
      [mkTask({ id: "task_a" }), mkTask({ id: "task_b" })],
      [dep("task_b", "task_a"), dep("task_a", "task_b")], // cycle
    );
    expect(dto.rows.map((r) => r.taskId)).toEqual(["task_a", "task_b"]);
    for (const r of dto.rows) expect(r.startsAt).toBeNull(); // no dueAt + failed CPM => no bar
    expect(dto.criticalTaskIds).toEqual([]);
  });

  it("builds FS dependency lines with predecessor=dependsOnId, successor=taskId", () => {
    const dto = buildGanttChartDTO("event_1", [mkTask({ id: "task_a" }), mkTask({ id: "task_b" })], [dep("task_b", "task_a")]);
    expect(dto.dependencies).toEqual([
      { id: "task_b->task_a", fromTaskId: "task_a", toTaskId: "task_b", type: "FS", lagDays: 0 },
    ]);
  });

  it("excludes archived tasks and drops dependency lines with a missing endpoint", () => {
    const dto = buildGanttChartDTO(
      "event_1",
      [mkTask({ id: "task_a" }), mkTask({ id: "task_b", archivedAt: "2026-08-02T00:00:00Z" })],
      [dep("task_b", "task_a"), dep("task_a", "task_ghost")],
    );
    expect(dto.rows.map((r) => r.taskId)).toEqual(["task_a"]);
    expect(dto.dependencies).toEqual([]); // both edges dangle after filtering
  });

  it("dedups repeated composite keys", () => {
    const dto = buildGanttChartDTO(
      "event_1",
      [mkTask({ id: "task_a" }), mkTask({ id: "task_b" })],
      [dep("task_b", "task_a"), dep("task_b", "task_a")],
    );
    expect(dto.dependencies).toHaveLength(1);
  });

  it("empty event -> empty rows and dependencies", () => {
    expect(buildGanttChartDTO("event_1", [], [])).toEqual({
      eventId: "event_1",
      rows: [],
      dependencies: [],
      criticalTaskIds: [],
    });
  });

  it("projects the WBS tree: team, parent/child, depth, pre-order, parent rolls up", () => {
    // Two work-packages (no dueAt) each with leaves; supplied out of order to prove
    // the DTO re-orders into pre-order (parent immediately followed by its leaves).
    const dto = buildGanttChartDTO(
      "event_1",
      [
        mkTask({ id: "leaf_b2", parentTaskId: "wp_b", teamId: "team_ops", wbs: "2.2", dueAt: "2026-08-20T00:00:00Z" }),
        mkTask({ id: "wp_a", teamId: "team_fin", wbs: "1.0" }),
        mkTask({ id: "leaf_a2", parentTaskId: "wp_a", teamId: "team_fin", wbs: "1.2", dueAt: "2026-08-12T00:00:00Z" }),
        mkTask({ id: "wp_b", teamId: "team_ops", wbs: "2.0" }),
        mkTask({ id: "leaf_a1", parentTaskId: "wp_a", teamId: "team_fin", wbs: "1.1", dueAt: "2026-08-10T00:00:00Z" }),
      ],
      [],
    );
    // pre-order by WBS: wp_a, its leaves (1.1,1.2), then wp_b, its leaf (2.2).
    expect(dto.rows.map((r) => r.taskId)).toEqual(["wp_a", "leaf_a1", "leaf_a2", "wp_b", "leaf_b2"]);

    const byId = Object.fromEntries(dto.rows.map((r) => [r.taskId, r]));
    // parent: has children, depth 0, team projected, and NO own dates (client rolls up).
    expect(byId.wp_a).toMatchObject({ hasChildren: true, depth: 0, teamId: "team_fin", parentTaskId: null, startsAt: null, endsAt: null });
    // leaf: depth 1, points at its parent, deadline-anchored bar, team projected.
    expect(byId.leaf_a1).toMatchObject({ hasChildren: false, depth: 1, parentTaskId: "wp_a", teamId: "team_fin", endsAt: "2026-08-10T00:00:00Z" });
    expect(byId.wp_b).toMatchObject({ hasChildren: true, teamId: "team_ops" });
  });

  it("ignores a parentTaskId pointing outside the live set (flat top-level row)", () => {
    const dto = buildGanttChartDTO("event_1", [mkTask({ id: "orphan", parentTaskId: "ghost", teamId: "team_x" })], []);
    expect(dto.rows[0]).toMatchObject({ parentTaskId: null, depth: 0, hasChildren: false, teamId: "team_x" });
  });
});

describe("startAt/dueAt bar derivation (PR-C: real dates win)", () => {
  it("both explicit → the bar spans exactly [startAt, dueAt] (ignores priority duration)", () => {
    const dto = buildGanttChartDTO(
      "event_1",
      [mkTask({ id: "t", priority: "urgent", startAt: "2026-08-03T00:00:00Z", dueAt: "2026-08-20T00:00:00Z" })],
      [],
    );
    expect(dto.rows[0]).toMatchObject({ startsAt: "2026-08-03T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" });
  });

  it("start only → a nominal-duration bar anchored at the real start", () => {
    const dto = buildGanttChartDTO("event_1", [mkTask({ id: "t", priority: "medium", startAt: "2026-08-05T00:00:00Z" })], []);
    const row = dto.rows[0]!;
    expect(row.startsAt).toBe("2026-08-05T00:00:00Z");
    // medium = 3 days → end is start + 3d.
    expect(new Date(row.endsAt!).getTime() - new Date(row.startsAt!).getTime()).toBe(3 * 86_400_000);
  });

  it("gives a dateless-but-scheduled task an arrow-linkable bar (both endpoints have dates)", () => {
    const rows = buildGanttChartDTO(
      "event_1",
      [
        mkTask({ id: "a", startAt: "2026-08-01T00:00:00Z", dueAt: "2026-08-05T00:00:00Z" }),
        mkTask({ id: "b", startAt: "2026-08-06T00:00:00Z", dueAt: "2026-08-09T00:00:00Z" }),
      ],
      [dep("b", "a")], // b depends on a — arrow only renders when both bars exist
    ).rows;
    for (const r of rows) {
      expect(r.startsAt).not.toBeNull();
      expect(r.endsAt).not.toBeNull();
    }
  });
});
