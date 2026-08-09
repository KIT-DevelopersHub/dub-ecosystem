// CPM forward/backward pass in day-space. Shared by computeRollup (ES/LF) and
// computeCriticalPath (slack). Pure & deterministic: no Date.now, stable order.
//
// Dependency kinds (predecessor = dependsOnId, successor = taskId), lag in days:
//   FS: succ.ES >= pred.EF + lag        (default; finish-to-start)
//   SS: succ.ES >= pred.ES + lag        (start-to-start)
//   FF: succ.EF >= pred.EF + lag        (finish-to-finish)
//   SF: succ.EF >= pred.ES + lag        (start-to-finish)
// EF = ES + duration, so FF/SF fold into an ES constraint via -duration(succ).
//
// When a WorkCalendar is supplied all math runs in working-day *ordinal* space
// (durations & lags are working days); without one it runs in calendar days.
// Either way the formulas below are identical — only the unit<->calendar-day
// mapping changes, isolated behind `mapper`.
import { DubError } from "@dub/errors";
import type { common, ganttCalc } from "@dub/types";
import { dayOf } from "./dates";
import type { WorkCalendar } from "./calendar";
import { topologicalSort, GANTT_CALC_UNKNOWN_TASK_REF } from "./graph";

type TaskId = common.TaskId;
type DepKind = ganttCalc.GanttCalcDependencyKind;

export interface ScheduleOptions {
  /** Skip weekends/holidays and treat durations & lags as working days. */
  calendar?: WorkCalendar;
}

export interface ScheduleNode {
  earliestStartDay: number;
  earliestFinishDay: number;
  latestStartDay: number;
  latestFinishDay: number;
  slackDays: number;
}

export interface Schedule {
  order: TaskId[]; // topological order
  nodes: Map<TaskId, ScheduleNode>;
  projectStartDay: number;
  projectEndDay: number;
  /** Maps a schedule unit (calendar day, or working-day ordinal under a
   *  calendar) back to a calendar day index for isoAtDay. Identity by default. */
  toCalendarDay: (unit: number) => number;
}

interface Edge {
  id: TaskId;
  kind: DepKind;
  lag: number;
}

interface DayMapper {
  /** calendar day index -> schedule unit (start-snapping under a calendar). */
  fromDay: (day: number) => number;
  /** schedule unit -> calendar day index. */
  toDay: (unit: number) => number;
}

const IDENTITY_MAPPER: DayMapper = { fromDay: (d) => d, toDay: (u) => u };

function durationOf(task: ganttCalc.GanttCalcTask): number {
  return Math.max(0, Math.trunc(task.durationDays));
}

function edgeOf(dep: ganttCalc.GanttCalcDependency): Edge {
  return { id: dep.dependsOnId, kind: dep.kind ?? "FS", lag: Math.trunc(dep.lagDays ?? 0) };
}

/** Guard that every dependency endpoint exists in the task set. */
export function assertKnownRefs(tasks: ganttCalc.GanttCalcTask[], deps: ganttCalc.GanttCalcDependency[]): void {
  const known = new Set(tasks.map((t) => t.id));
  const unknown = new Set<TaskId>();
  for (const dep of deps) {
    if (!known.has(dep.taskId)) unknown.add(dep.taskId);
    if (!known.has(dep.dependsOnId)) unknown.add(dep.dependsOnId);
  }
  if (unknown.size > 0) {
    throw new DubError(GANTT_CALC_UNKNOWN_TASK_REF, "dependency references unknown task id", {
      status: 422,
      details: { unknownTaskIds: [...unknown].sort() },
    });
  }
}

export function computeSchedule(
  tasks: ganttCalc.GanttCalcTask[],
  deps: ganttCalc.GanttCalcDependency[],
  options: ScheduleOptions = {},
): Schedule {
  assertKnownRefs(tasks, deps);
  const order = topologicalSort(tasks.map((t) => t.id), deps); // throws on cycle

  const cal = options.calendar;
  const mapper: DayMapper = cal
    ? { fromDay: (d) => cal.toOrdinal(d), toDay: (u) => cal.fromOrdinal(u) }
    : IDENTITY_MAPPER;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  // predecessors[succ] carries the edge (pred + kind + lag); successors[pred]
  // carries the mirror edge (succ + kind + lag) for the backward pass.
  const predecessors = new Map<TaskId, Edge[]>();
  const successors = new Map<TaskId, Edge[]>();
  for (const t of tasks) {
    predecessors.set(t.id, []);
    successors.set(t.id, []);
  }
  for (const dep of deps) {
    const e = edgeOf(dep);
    predecessors.get(dep.taskId)!.push(e);
    successors.get(dep.dependsOnId)!.push({ id: dep.taskId, kind: e.kind, lag: e.lag });
  }

  // anchor = earliest explicit start (in schedule units); if none, day 0 (epoch).
  const explicitStarts = tasks
    .filter((t) => t.startsAt !== null)
    .map((t) => mapper.fromDay(dayOf(t.startsAt as string, "startsAt")));
  const anchorUnit = explicitStarts.length > 0 ? Math.min(...explicitStarts) : mapper.fromDay(0);
  const startConstraint = (t: ganttCalc.GanttCalcTask): number =>
    t.startsAt !== null ? mapper.fromDay(dayOf(t.startsAt, "startsAt")) : anchorUnit;

  const nodes = new Map<TaskId, ScheduleNode>();
  for (const t of tasks) {
    nodes.set(t.id, { earliestStartDay: 0, earliestFinishDay: 0, latestStartDay: 0, latestFinishDay: 0, slackDays: 0 });
  }

  // forward pass (topological order)
  for (const id of order) {
    const t = byId.get(id)!;
    const dur = durationOf(t);
    let es = startConstraint(t);
    for (const p of predecessors.get(id)!) {
      const pn = nodes.get(p.id)!;
      es = Math.max(es, esConstraint(p.kind, pn, p.lag, dur));
    }
    const node = nodes.get(id)!;
    node.earliestStartDay = es;
    node.earliestFinishDay = es + dur;
  }

  const projectEndDay = tasks.length === 0 ? anchorUnit : Math.max(...tasks.map((t) => nodes.get(t.id)!.earliestFinishDay));
  const projectStartDay = tasks.length === 0 ? anchorUnit : Math.min(...tasks.map((t) => nodes.get(t.id)!.earliestStartDay));

  // backward pass (reverse topological order)
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const t = byId.get(id)!;
    const dur = durationOf(t);
    let lf = projectEndDay;
    for (const s of successors.get(id)!) {
      const sn = nodes.get(s.id)!;
      lf = Math.min(lf, lfConstraint(s.kind, sn, s.lag, dur));
    }
    const node = nodes.get(id)!;
    node.latestFinishDay = lf;
    node.latestStartDay = lf - dur;
    node.slackDays = node.latestStartDay - node.earliestStartDay;
  }

  return { order, nodes, projectStartDay, projectEndDay, toCalendarDay: mapper.toDay };
}

// Earliest-start lower bound imposed on a successor (duration = succDur) by one
// predecessor, per dependency kind.
function esConstraint(kind: DepKind, pred: ScheduleNode, lag: number, succDur: number): number {
  switch (kind) {
    case "SS":
      return pred.earliestStartDay + lag;
    case "FF":
      return pred.earliestFinishDay + lag - succDur;
    case "SF":
      return pred.earliestStartDay + lag - succDur;
    case "FS":
    default:
      return pred.earliestFinishDay + lag;
  }
}

// Latest-finish upper bound imposed on a predecessor (duration = predDur) by one
// successor, per dependency kind (mirror of esConstraint).
function lfConstraint(kind: DepKind, succ: ScheduleNode, lag: number, predDur: number): number {
  switch (kind) {
    case "SS":
      return succ.latestStartDay - lag + predDur;
    case "FF":
      return succ.latestFinishDay - lag;
    case "SF":
      return succ.latestFinishDay - lag + predDur;
    case "FS":
    default:
      return succ.latestStartDay - lag;
  }
}
