// CPM forward/backward pass in day-space. Shared by computeRollup (ES/LF) and
// computeCriticalPath (slack). Pure & deterministic: no Date.now, stable order.
import { DubError } from "@dub/errors";
import type { common, ganttCalc } from "@dub/types";
import { dayOf } from "./dates";
import { topologicalSort, GANTT_CALC_UNKNOWN_TASK_REF } from "./graph";

type TaskId = common.TaskId;

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
}

function durationOf(task: ganttCalc.GanttCalcTask): number {
  return Math.max(0, Math.trunc(task.durationDays));
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
): Schedule {
  assertKnownRefs(tasks, deps);
  const order = topologicalSort(tasks.map((t) => t.id), deps); // throws on cycle

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const predecessors = new Map<TaskId, TaskId[]>();
  const successors = new Map<TaskId, TaskId[]>();
  for (const t of tasks) {
    predecessors.set(t.id, []);
    successors.set(t.id, []);
  }
  for (const dep of deps) {
    predecessors.get(dep.taskId)!.push(dep.dependsOnId);
    successors.get(dep.dependsOnId)!.push(dep.taskId);
  }

  // anchor = earliest explicit start; if none, day 0 (epoch).
  const explicitStarts = tasks
    .filter((t) => t.startsAt !== null)
    .map((t) => dayOf(t.startsAt as string, "startsAt"));
  const anchorDay = explicitStarts.length > 0 ? Math.min(...explicitStarts) : 0;
  const startConstraint = (t: ganttCalc.GanttCalcTask): number =>
    t.startsAt !== null ? dayOf(t.startsAt, "startsAt") : anchorDay;

  const nodes = new Map<TaskId, ScheduleNode>();
  for (const t of tasks) {
    nodes.set(t.id, { earliestStartDay: 0, earliestFinishDay: 0, latestStartDay: 0, latestFinishDay: 0, slackDays: 0 });
  }

  // forward pass (topological order)
  for (const id of order) {
    const t = byId.get(id)!;
    let es = startConstraint(t);
    for (const p of predecessors.get(id)!) es = Math.max(es, nodes.get(p)!.earliestFinishDay);
    const node = nodes.get(id)!;
    node.earliestStartDay = es;
    node.earliestFinishDay = es + durationOf(t);
  }

  const projectEndDay = tasks.length === 0 ? anchorDay : Math.max(...tasks.map((t) => nodes.get(t.id)!.earliestFinishDay));
  const projectStartDay = tasks.length === 0 ? anchorDay : Math.min(...tasks.map((t) => nodes.get(t.id)!.earliestStartDay));

  // backward pass (reverse topological order)
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const t = byId.get(id)!;
    const succ = successors.get(id)!;
    let lf = projectEndDay;
    if (succ.length > 0) lf = Math.min(...succ.map((s) => nodes.get(s)!.latestStartDay));
    const node = nodes.get(id)!;
    node.latestFinishDay = lf;
    node.latestStartDay = lf - durationOf(t);
    node.slackDays = node.latestStartDay - node.earliestStartDay;
  }

  return { order, nodes, projectStartDay, projectEndDay };
}
