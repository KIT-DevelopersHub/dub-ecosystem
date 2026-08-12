// Pure DTO assembly: task/dependency source -> GanttChartDTO (@dub/types gantt).
// The variation layer stays thin (テーマ: gantt is a transform layer, no business
// data). Task has no start field, so the read model *derives* each bar's window:
//   - dueAt present  -> bar = [dueAt - durationDays, dueAt]  (deadline-anchored)
//   - dueAt absent   -> CPM forward-schedule via @dub/gantt-calc, anchored at the
//                       project start, so dependency order still yields a bar.
// gantt-calc also gives the critical path (zero-slack chain) for bar colouring.
import type { task, gantt, common } from "@dub/types";
import { computeRollup, computeCriticalPath, dayOf, isoAtDay } from "@dub/gantt-calc";
import { isDubError } from "@dub/errors";

/** Task status -> progress (P0: done=100, everything else=0; no partial progress). */
export function progressOf(status: task.TaskStatus): number {
  return status === "done" ? 100 : 0;
}

/** Nominal working length per priority (days). Urgent work is short & sharp; low
 *  priority spreads wider. Drives bar width and the CPM schedule below. */
const DURATION_BY_PRIORITY: Record<task.TaskPriority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 5,
};

export function durationDaysOf(priority: task.TaskPriority): number {
  return DURATION_BY_PRIORITY[priority];
}

/** Derived per-task schedule: earliest-start day offset (from project start) and
 *  the critical-path set. Pure CPM over durations + FS deps; never throws — a
 *  cyclic/invalid graph degrades to "no derived offsets" so the chart still loads. */
interface DerivedSchedule {
  esOffsetByTask: Record<common.TaskId, number>;
  criticalTaskIds: common.TaskId[];
}

function deriveSchedule(
  live: task.Task[],
  deps: gantt.GanttDependencyLine[],
): DerivedSchedule {
  const calcTasks = live.map((t) => ({
    id: t.id,
    startsAt: null,
    endsAt: null,
    durationDays: durationDaysOf(t.priority),
  }));
  // predecessor = dependsOnId = fromTaskId, successor = taskId = toTaskId (frozen).
  const calcDeps = deps.map((d) => ({ taskId: d.toTaskId, dependsOnId: d.fromTaskId }));
  try {
    const rollup = computeRollup({ tasks: calcTasks, dependencies: calcDeps });
    const cp = computeCriticalPath({ tasks: calcTasks, dependencies: calcDeps });
    const esOffsetByTask: Record<common.TaskId, number> = {};
    for (const t of live) esOffsetByTask[t.id] = dayOf(rollup.earliestStart[t.id]!);
    return { esOffsetByTask, criticalTaskIds: cp.criticalTaskIds };
  } catch (e) {
    // 422 cycle / unknown-ref: keep the read model resilient (bars fall back to
    // dueAt-only). Re-throw anything unexpected so real bugs still surface.
    if (isDubError(e)) return { esOffsetByTask: {}, criticalTaskIds: [] };
    throw e;
  }
}

/** Build a gantt row, deriving the bar window (see file header). */
function toRow(
  t: task.Task,
  anchorDay: number,
  esOffsetByTask: Record<common.TaskId, number>,
): gantt.GanttRow {
  const dur = durationDaysOf(t.priority);
  let startsAt: common.ISODateTime | null = null;
  let endsAt: common.ISODateTime | null = null;
  if (t.dueAt) {
    endsAt = t.dueAt;
    startsAt = isoAtDay(dayOf(t.dueAt) - dur);
  } else if (t.id in esOffsetByTask) {
    const start = anchorDay + esOffsetByTask[t.id]!;
    startsAt = isoAtDay(start);
    endsAt = isoAtDay(start + dur);
  }
  return {
    taskId: t.id,
    title: t.title,
    startsAt,
    endsAt,
    progressPercent: progressOf(t.status),
    assigneeId: t.assigneeId,
  };
}

/** Project start day: earliest deadline-anchored start, else earliest createdAt,
 *  else today. Anchors CPM-derived (dueAt-less) bars onto the real calendar. */
function anchorDayOf(live: task.Task[]): number {
  const dueStarts = live
    .filter((t) => t.dueAt !== null)
    .map((t) => dayOf(t.dueAt!) - durationDaysOf(t.priority));
  if (dueStarts.length > 0) return Math.min(...dueStarts);
  const created = live.map((t) => dayOf(t.createdAt));
  if (created.length > 0) return Math.min(...created);
  return dayOf(new Date().toISOString());
}

/** Assemble the chart DTO. Dependency lines whose endpoints are not both present
 *  in the (non-archived) row set are dropped — no dangling edges. */
export function buildGanttChartDTO(
  eventId: common.EventId,
  tasks: task.Task[],
  dependencies: task.TaskDependency[],
): gantt.GanttChartDTO {
  const live = tasks.filter((t) => t.archivedAt === null);
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

  const { esOffsetByTask, criticalTaskIds } = deriveSchedule(live, lines);
  const anchorDay = anchorDayOf(live);
  const rows = live.map((t) => toRow(t, anchorDay, esOffsetByTask));

  return { eventId, rows, dependencies: lines, criticalTaskIds };
}
