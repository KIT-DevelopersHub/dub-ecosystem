// @dub/gantt-calc — stateless pure calculation lib. HTTP-free (テーマ scope: pure
// function module; gantt-calc-service, if physically split later, is a thin wrapper).
// Contract types live in @dub/types (ganttCalc namespace, P0b frozen).
import type { ganttCalc } from "@dub/types";
import { isoAtDay } from "./dates";
import { computeSchedule, type ScheduleOptions } from "./schedule";

export { topologicalSort, validateDependencies, GANTT_CALC_DEPENDENCY_CYCLE, GANTT_CALC_UNKNOWN_TASK_REF } from "./graph";
export type { ValidateDependenciesRequest, ValidateDependenciesResponse } from "./graph";
export { dayOf, isoAtDay } from "./dates";
export { computeSchedule } from "./schedule";
export type { Schedule, ScheduleNode, ScheduleOptions } from "./schedule";
export { createWorkCalendar, dayOfWeek } from "./calendar";
export type { WorkCalendar, WorkCalendarOptions } from "./calendar";

/**
 * Schedule rollup: earliest-start / latest-finish per task via CPM forward &
 * backward pass over FS dependencies. Throws GANTT_CALC_UNKNOWN_TASK_REF /
 * GANTT_CALC_DEPENDENCY_CYCLE (422) on invalid graphs.
 */
export function computeRollup(
  req: ganttCalc.RollupRequest,
  options?: ScheduleOptions,
): ganttCalc.RollupResponse {
  const schedule = computeSchedule(req.tasks, req.dependencies, options);
  const earliestStart: Record<string, string> = {};
  const latestFinish: Record<string, string> = {};
  for (const t of req.tasks) {
    const node = schedule.nodes.get(t.id)!;
    earliestStart[t.id] = isoAtDay(schedule.toCalendarDay(node.earliestStartDay));
    latestFinish[t.id] = isoAtDay(schedule.toCalendarDay(node.latestFinishDay));
  }
  return { earliestStart, latestFinish };
}

/**
 * Critical path: the set of zero-slack tasks (topological order) and the total
 * project duration in days. Deterministic; throws on unknown-ref / cycle (422).
 */
export function computeCriticalPath(
  req: ganttCalc.CriticalPathRequest,
  options?: ScheduleOptions,
): ganttCalc.CriticalPathResponse {
  const schedule = computeSchedule(req.tasks, req.dependencies, options);
  const criticalTaskIds = schedule.order.filter((id) => schedule.nodes.get(id)!.slackDays === 0);
  const totalDurationDays = req.tasks.length === 0 ? 0 : schedule.projectEndDay - schedule.projectStartDay;
  return { criticalTaskIds, totalDurationDays };
}
