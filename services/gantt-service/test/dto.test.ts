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
});
