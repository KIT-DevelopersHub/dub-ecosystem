import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { buildGanttChartDTO, progressOf } from "../src/dto";

function mkTask(over: Partial<task.Task> & { id: string }): task.Task {
  return {
    id: over.id,
    eventId: over.eventId ?? "event_1",
    title: over.title ?? over.id,
    description: null,
    status: over.status ?? "todo",
    priority: "medium",
    assigneeId: over.assigneeId ?? null,
    dueAt: over.dueAt ?? null,
    origin: "internal",
    archivedAt: over.archivedAt ?? null,
    createdAt: "2026-08-01T00:00:00Z",
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

describe("buildGanttChartDTO", () => {
  it("maps tasks to rows (startsAt=null, endsAt=dueAt, progress from status)", () => {
    const dto = buildGanttChartDTO("event_1", [
      mkTask({ id: "task_a", dueAt: "2026-08-10T00:00:00Z", status: "done", assigneeId: "user_x" }),
    ], []);
    expect(dto.eventId).toBe("event_1");
    expect(dto.rows).toEqual([
      { taskId: "task_a", title: "task_a", startsAt: null, endsAt: "2026-08-10T00:00:00Z", progressPercent: 100, assigneeId: "user_x" },
    ]);
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
    expect(buildGanttChartDTO("event_1", [], [])).toEqual({ eventId: "event_1", rows: [], dependencies: [] });
  });
});
