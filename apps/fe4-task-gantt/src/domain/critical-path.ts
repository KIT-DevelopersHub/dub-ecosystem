// Dynamic critical-path derivation for the gantt view.
//
// The read model's `criticalTaskIds` (when present) is a SNAPSHOT computed by
// gantt-service at fetch time — it does NOT follow the live, optimistic edits the
// user makes on the timeline (drag a bar, resize a span, add/remove a dependency).
// To make the red critical path track those edits the instant they happen, we
// recompute it on the client from the currently-displayed rows + dependencies via
// the same pure CPM engine the backend uses (@dub/gantt-calc), so front and back
// agree on the algorithm (single source of truth for the math).
//
// Pure & side-effect-free: given the same rows/deps it returns the same set, and it
// NEVER throws — a dependency cycle (which the CPM engine rejects with a 422-style
// DubError) or any malformed graph degrades to an empty set (no red path) rather
// than crashing the chart. A cycle can only ever be transient here (the editor
// prevents committing one), so "show nothing until it's a DAG again" is the safe
// behaviour and there is no infinite loop.
import type { common, gantt, ganttCalc } from "@dub/types";
import { computeCriticalPath } from "@dub/gantt-calc";

const MS_PER_DAY = 86_400_000;

/** Whole-day duration of a dated row (⌈(end-start)/day⌉, min 0). Null-dated rows
 *  (no bar) contribute duration 0 so they can still anchor a dependency edge. */
function durationDaysOf(row: gantt.GanttRow): number {
  if (!row.startsAt || !row.endsAt) return 0;
  const ms = Date.parse(row.endsAt) - Date.parse(row.startsAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / MS_PER_DAY);
}

/**
 * The set of zero-slack (critical-path) task ids for the given rows + dependencies,
 * recomputed live. Empty when there are no rows, or when the graph is momentarily
 * invalid (cycle / unknown ref) — see the module note. Every row is passed to the
 * engine (so every dependency endpoint is a known ref); the FS lines map to the
 * engine's predecessor→successor edges (dependsOnId = predecessor = fromTaskId).
 */
export function deriveCriticalTaskIds(
  rows: readonly gantt.GanttRow[],
  dependencies: readonly gantt.GanttDependencyLine[],
): ReadonlySet<common.TaskId> {
  if (rows.length === 0) return EMPTY;
  const tasks: ganttCalc.GanttCalcTask[] = rows.map((r) => ({
    id: r.taskId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    durationDays: durationDaysOf(r),
  }));
  const deps: ganttCalc.GanttCalcDependency[] = dependencies.map((d) => ({
    taskId: d.toTaskId, // successor
    dependsOnId: d.fromTaskId, // predecessor
    kind: "FS",
    lagDays: d.lagDays,
  }));
  try {
    const { criticalTaskIds } = computeCriticalPath({ tasks, dependencies: deps });
    return new Set(criticalTaskIds);
  } catch {
    // cycle / unknown ref — transient during editing; show no path until it's a DAG.
    return EMPTY;
  }
}

const EMPTY: ReadonlySet<common.TaskId> = new Set();
