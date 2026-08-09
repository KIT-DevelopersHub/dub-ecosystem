// Pure DTO assembly: task/dependency source -> GanttChartDTO (@dub/types gantt).
// The variation layer stays thin (テーマ: gantt is a transform layer, no business data).
import type { task, gantt, common } from "@dub/types";

/** Task status -> progress (P0: done=100, everything else=0; no partial progress). */
export function progressOf(status: task.TaskStatus): number {
  return status === "done" ? 100 : 0;
}

/** Build a gantt row from a task. Frozen Task has no start field -> startsAt=null,
 *  endsAt=dueAt. Archived tasks must be filtered out by the caller. */
export function toRow(t: task.Task): gantt.GanttRow {
  return {
    taskId: t.id,
    title: t.title,
    startsAt: null,
    endsAt: t.dueAt,
    progressPercent: progressOf(t.status),
    assigneeId: t.assigneeId,
  };
}

/** Assemble the chart DTO. Dependency lines whose endpoints are not both present
 *  in the (non-archived) row set are dropped — no dangling edges. */
export function buildGanttChartDTO(
  eventId: common.EventId,
  tasks: task.Task[],
  dependencies: task.TaskDependency[],
): gantt.GanttChartDTO {
  const live = tasks.filter((t) => t.archivedAt === null);
  const rows = live.map(toRow);
  const ids = new Set(live.map((t) => t.id));

  const seen = new Set<string>();
  const lines: gantt.GanttDependencyLine[] = [];
  for (const dep of dependencies) {
    if (!ids.has(dep.taskId) || !ids.has(dep.dependsOnId)) continue; // drop dangling
    const id = `${dep.taskId}->${dep.dependsOnId}`;
    if (seen.has(id)) continue; // dedup composite PK
    seen.add(id);
    lines.push({
      id,
      fromTaskId: dep.dependsOnId, // predecessor (先行)
      toTaskId: dep.taskId, // successor (後続)
      type: "FS", // P0 constant
      lagDays: 0, // P0 constant
    });
  }

  return { eventId, rows, dependencies: lines };
}
