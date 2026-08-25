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

/** WBS hierarchy projected from the task set (all additive; a task with no live
 *  parent is a flat top-level row, so a flat event keeps rendering unchanged). */
interface Hierarchy {
  /** effective parent (null when absent or pointing outside the live set). */
  parentOf: Map<common.TaskId, common.TaskId | null>;
  /** ids that are some live row's effective parent (→ collapse/expand toggle). */
  hasChildren: Set<common.TaskId>;
  /** depth in the tree (0 = top-level / work-package, 1 = leaf, …). */
  depthOf: Map<common.TaskId, number>;
}

function buildHierarchy(live: task.Task[]): Hierarchy {
  const liveIds = new Set(live.map((t) => t.id));
  const parentOf = new Map<common.TaskId, common.TaskId | null>();
  const hasChildren = new Set<common.TaskId>();
  for (const t of live) {
    // Ignore a parent that isn't itself a live row (avoids orphaned/dangling nests).
    const p = t.parentTaskId && liveIds.has(t.parentTaskId) ? t.parentTaskId : null;
    parentOf.set(t.id, p);
    if (p) hasChildren.add(p);
  }
  // Depth by walking the parent chain (cycle-guarded so a bad edge can't hang).
  const depthOf = new Map<common.TaskId, number>();
  const depth = (id: common.TaskId, guard: Set<common.TaskId>): number => {
    const cached = depthOf.get(id);
    if (cached !== undefined) return cached;
    const p = parentOf.get(id) ?? null;
    if (!p || guard.has(id)) {
      depthOf.set(id, 0);
      return 0;
    }
    guard.add(id);
    const d = depth(p, guard) + 1;
    depthOf.set(id, d);
    return d;
  };
  for (const t of live) depth(t.id, new Set());
  return { parentOf, hasChildren, depthOf };
}

/** Numeric-aware WBS comparator ("1.2.10" > "1.2.9"). Missing wbs sorts last. */
function compareWbs(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Build a gantt row, deriving the bar window (see file header). A work-package
 *  (hasChildren) carries NO own dates — the UI rolls its span up from its children
 *  so the parent bar always exactly encloses them. */
function toRow(
  t: task.Task,
  anchorDay: number,
  esOffsetByTask: Record<common.TaskId, number>,
  h: Hierarchy,
): gantt.GanttRow {
  const isParent = h.hasChildren.has(t.id);
  const dur = durationDaysOf(t.priority);
  let startsAt: common.ISODateTime | null = null;
  let endsAt: common.ISODateTime | null = null;
  if (isParent) {
    // parent span is derived from children (rollup on the client); leave null.
  } else if (t.startAt && t.dueAt) {
    // Both explicit ⇒ the bar spans exactly [startAt, dueAt] (PR-C: real dates win
    // over the derived window, so a user-set start/due gives an arrow-linkable bar).
    startsAt = t.startAt;
    endsAt = t.dueAt;
  } else if (t.dueAt) {
    endsAt = t.dueAt;
    startsAt = isoAtDay(dayOf(t.dueAt) - dur);
  } else if (t.startAt) {
    // Start only ⇒ anchor a nominal-duration bar at the real start.
    startsAt = t.startAt;
    endsAt = isoAtDay(dayOf(t.startAt) + dur);
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
    teamId: t.teamId ?? null,
    parentTaskId: h.parentOf.get(t.id) ?? null,
    depth: h.depthOf.get(t.id) ?? 0,
    hasChildren: isParent,
    ...(t.wbs ? { wbs: t.wbs } : {}),
  };
}

/** Project start day: earliest deadline-anchored start, else earliest createdAt,
 *  else today. Anchors CPM-derived (dueAt-less) bars onto the real calendar. */
function anchorDayOf(live: task.Task[]): number {
  // Earliest real anchor: an explicit startAt, or a deadline-anchored derived start.
  const explicitStarts = live.filter((t) => t.startAt).map((t) => dayOf(t.startAt!));
  const dueStarts = live
    .filter((t) => t.dueAt !== null)
    .map((t) => dayOf(t.dueAt!) - durationDaysOf(t.priority));
  const anchored = [...explicitStarts, ...dueStarts];
  if (anchored.length > 0) return Math.min(...anchored);
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
  const h = buildHierarchy(live);

  // Pre-order the rows so every parent is immediately followed by its own children
  // block (the client's group-band + contiguous-run assumptions rely on it). Roots
  // and each sibling group are ordered by WBS, then title as a stable tiebreak.
  const byId = new Map(live.map((t) => [t.id, t]));
  const childrenByParent = new Map<common.TaskId | null, task.Task[]>();
  for (const t of live) {
    const p = h.parentOf.get(t.id) ?? null;
    const arr = childrenByParent.get(p);
    if (arr) arr.push(t);
    else childrenByParent.set(p, [t]);
  }
  const sortSiblings = (a: task.Task, b: task.Task): number => {
    const w = compareWbs(a.wbs, b.wbs);
    return w !== 0 ? w : a.title.localeCompare(b.title);
  };
  const ordered: task.Task[] = [];
  const emitted = new Set<common.TaskId>();
  const walk = (parent: common.TaskId | null): void => {
    const kids = (childrenByParent.get(parent) ?? []).slice().sort(sortSiblings);
    for (const t of kids) {
      if (emitted.has(t.id)) continue; // cycle-guard
      emitted.add(t.id);
      ordered.push(t);
      walk(t.id);
    }
  };
  walk(null);
  // Safety net: any row not reached (shouldn't happen) still ships, appended in
  // WBS order, so no task is silently dropped from the chart.
  if (ordered.length < live.length) {
    for (const t of [...live].sort(sortSiblings)) if (!emitted.has(t.id)) ordered.push(t);
  }

  const rows = ordered.map((t) => toRow(byId.get(t.id)!, anchorDay, esOffsetByTask, h));

  return { eventId, rows, dependencies: lines, criticalTaskIds };
}
