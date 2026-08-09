// gantt — GanttView (S6) view-model over the frozen gantt / gantt-calc shapes
// (design §2-1 S6). The MO3 read endpoint returns a `gantt.GanttChartDTO`
// (rows + FS dependency lines); this pure layer derives the two things the
// Swift GanttViewModel and its tests must agree on:
//   1. 依存順序 — a stable dependency (topological) ordering + per-row depth,
//      with cycle detection that degrades to source order (never throws).
//   2. 日付レンジ — the chart date window and each row's day offset/duration.
// Ordering + range are computed on the `ganttCalc` namespace shapes (the same
// GanttCalcTask/GanttCalcDependency task-service feeds its rollup), so the
// reference layer consumes the frozen calc contract rather than re-deriving it.
import type { gantt, ganttCalc } from "@dub/types";

type TaskId = string;

const DAY_MS = 86_400_000;

/** Whole-day difference b - a (ISO8601). Non-parseable inputs collapse to 0. */
export function dayDiff(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((tb - ta) / DAY_MS);
}

export interface GanttDateRange {
  /** earliest row start (ISO8601), or null when nothing is scheduled. */
  start: string | null;
  /** latest row end (ISO8601), or null when nothing is scheduled. */
  end: string | null;
  /** inclusive span in days (0 when unscheduled or single-day). */
  totalDays: number;
}

export interface DependencyOrder {
  /** task ids in dependency order (predecessors before successors). */
  order: TaskId[];
  /** longest-path depth from a dependency-free root (root = 0). */
  depth: Record<TaskId, number>;
  /** true when the dependency graph has a cycle (order falls back to source). */
  hasCycle: boolean;
}

/**
 * Stable topological order of `tasks` under `dependencies` (Kahn's algorithm).
 * A `ganttCalc.GanttCalcDependency` reads "taskId depends on dependsOnId", so
 * the edge points dependsOnId -> taskId. Dependencies touching unknown tasks
 * are ignored. On a cycle the un-orderable remainder is appended in source
 * order and `hasCycle` is set (the UI still renders — design §6 never-crash).
 */
export function dependencyOrder(
  tasks: readonly ganttCalc.GanttCalcTask[],
  dependencies: readonly ganttCalc.GanttCalcDependency[],
): DependencyOrder {
  const ids = tasks.map((t) => t.id);
  const known = new Set(ids);
  const indegree = new Map<TaskId, number>(ids.map((id) => [id, 0]));
  const successors = new Map<TaskId, TaskId[]>(ids.map((id) => [id, []]));

  for (const dep of dependencies) {
    if (!known.has(dep.taskId) || !known.has(dep.dependsOnId) || dep.taskId === dep.dependsOnId) continue;
    successors.get(dep.dependsOnId)!.push(dep.taskId);
    indegree.set(dep.taskId, indegree.get(dep.taskId)! + 1);
  }

  const depth: Record<TaskId, number> = {};
  for (const id of ids) depth[id] = 0;

  // Seed the queue in source order so equal-rank rows keep their input order.
  const queue: TaskId[] = ids.filter((id) => indegree.get(id) === 0);
  const order: TaskId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of successors.get(id)!) {
      depth[next] = Math.max(depth[next]!, depth[id]! + 1);
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  if (order.length < ids.length) {
    const placed = new Set(order);
    for (const id of ids) if (!placed.has(id)) order.push(id);
    return { order, depth, hasCycle: true };
  }
  return { order, depth, hasCycle: false };
}

/** Chart window across the scheduled `tasks` (unscheduled rows are skipped). */
export function dateRange(tasks: readonly ganttCalc.GanttCalcTask[]): GanttDateRange {
  let start: string | null = null;
  let end: string | null = null;
  for (const t of tasks) {
    if (t.startsAt !== null && (start === null || Date.parse(t.startsAt) < Date.parse(start))) start = t.startsAt;
    if (t.endsAt !== null && (end === null || Date.parse(t.endsAt) > Date.parse(end))) end = t.endsAt;
  }
  const totalDays = start !== null && end !== null ? Math.max(0, dayDiff(start, end)) : 0;
  return { start, end, totalDays };
}

// ---- view-model ------------------------------------------------------------

export interface GanttViewRow {
  taskId: TaskId;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  progressPercent: number;
  assigneeId: string | null;
  /** dependency depth (0 = no predecessors). */
  depth: number;
  /** day offset of the bar from `range.start`; null when unscheduled. */
  offsetDays: number | null;
  /** bar length in days (0 when unscheduled / single-day). */
  durationDays: number;
  /** mirrors GanttViewState.collapsedTaskIds so the UI can fold rows. */
  collapsed: boolean;
}

export interface GanttViewModel {
  eventId: string;
  zoom: gantt.GanttZoom;
  range: GanttDateRange;
  /** rows in dependency order. */
  rows: GanttViewRow[];
  dependencies: gantt.GanttDependencyLine[];
  hasCycle: boolean;
  collapsedTaskIds: TaskId[];
}

export interface GanttViewModelOptions {
  /** persisted GanttViewState (zoom + collapsed rows); sensible defaults else. */
  viewState?: Pick<gantt.GanttViewState, "zoom" | "collapsedTaskIds">;
}

/** A GanttRow finishing/starting date pair as a gantt-calc task. */
function toCalcTask(row: gantt.GanttRow): ganttCalc.GanttCalcTask {
  const durationDays = row.startsAt !== null && row.endsAt !== null ? Math.max(0, dayDiff(row.startsAt, row.endsAt)) : 0;
  return { id: row.taskId, startsAt: row.startsAt, endsAt: row.endsAt, durationDays };
}

/** An FS line ("from finishes before to starts") = "to depends on from". */
function toCalcDependency(line: gantt.GanttDependencyLine): ganttCalc.GanttCalcDependency {
  return { taskId: line.toTaskId, dependsOnId: line.fromTaskId };
}

/**
 * Build the GanttView view-model from the frozen chart DTO: order rows by their
 * FS dependencies, compute the date window, and place each bar within it.
 */
export function buildGanttViewModel(dto: gantt.GanttChartDTO, opts: GanttViewModelOptions = {}): GanttViewModel {
  const calcTasks = dto.rows.map(toCalcTask);
  const calcDeps = dto.dependencies.map(toCalcDependency);

  const { order, depth, hasCycle } = dependencyOrder(calcTasks, calcDeps);
  const range = dateRange(calcTasks);
  const collapsed = new Set(opts.viewState?.collapsedTaskIds ?? []);
  const byId = new Map(dto.rows.map((r) => [r.taskId, r]));

  const rows: GanttViewRow[] = order.map((id) => {
    const r = byId.get(id)!;
    const durationDays = r.startsAt !== null && r.endsAt !== null ? Math.max(0, dayDiff(r.startsAt, r.endsAt)) : 0;
    const offsetDays = range.start !== null && r.startsAt !== null ? dayDiff(range.start, r.startsAt) : null;
    return {
      taskId: r.taskId,
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      progressPercent: r.progressPercent,
      assigneeId: r.assigneeId,
      depth: depth[id] ?? 0,
      offsetDays,
      durationDays,
      collapsed: collapsed.has(id),
    };
  });

  return {
    eventId: dto.eventId,
    zoom: opts.viewState?.zoom ?? "week",
    range,
    rows,
    dependencies: dto.dependencies,
    hasCycle,
    collapsedTaskIds: [...collapsed],
  };
}

/** Persist body for the current view-model (design: PUT gantt view state). */
export function toPutGanttViewRequest(vm: Pick<GanttViewModel, "zoom" | "collapsedTaskIds">): gantt.PutGanttViewRequest {
  return { zoom: vm.zoom, collapsedTaskIds: vm.collapsedTaskIds };
}
