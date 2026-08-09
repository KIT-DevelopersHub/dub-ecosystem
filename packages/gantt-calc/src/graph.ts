// Dependency graph primitives: topological sort (throws on cycle) and a
// non-throwing validator (task-service imports validateDependencies to power its
// 409 on dependency-replace — [[正本・所有権の線引き]] frozen contract).
import { DubError } from "@dub/errors";
import type { common, ganttCalc } from "@dub/types";

export const GANTT_CALC_DEPENDENCY_CYCLE = "GANTT_CALC_DEPENDENCY_CYCLE";
export const GANTT_CALC_UNKNOWN_TASK_REF = "GANTT_CALC_UNKNOWN_TASK_REF";

type TaskId = common.TaskId;
type Dependency = ganttCalc.GanttCalcDependency;

// A dependency {taskId, dependsOnId} is FS: dependsOnId (predecessor) must finish
// before taskId (successor) starts. Edge direction = dependsOnId -> taskId.

export interface ValidateDependenciesRequest {
  taskIds: TaskId[];
  dependencies: Dependency[];
}
export interface ValidateDependenciesResponse {
  valid: boolean;
  cycles: TaskId[][]; // each cycle as an ordered id list
  unknownTaskIds: TaskId[]; // referenced by a dependency but not in taskIds
}

/** Deterministic Kahn topological sort. Throws GANTT_CALC_DEPENDENCY_CYCLE if the
 *  graph (restricted to known ids) contains a cycle. Ties broken by id asc. */
export function topologicalSort(taskIds: TaskId[], dependencies: Dependency[]): TaskId[] {
  const ids = [...new Set(taskIds)];
  const known = new Set(ids);
  const successors = new Map<TaskId, TaskId[]>();
  const indegree = new Map<TaskId, number>();
  for (const id of ids) {
    successors.set(id, []);
    indegree.set(id, 0);
  }
  for (const dep of dependencies) {
    if (!known.has(dep.dependsOnId) || !known.has(dep.taskId)) continue; // unknown handled elsewhere
    if (dep.dependsOnId === dep.taskId) {
      throw new DubError(GANTT_CALC_DEPENDENCY_CYCLE, "self-dependency", {
        status: 422,
        details: { cycles: [[dep.taskId]] },
      });
    }
    successors.get(dep.dependsOnId)!.push(dep.taskId);
    indegree.set(dep.taskId, indegree.get(dep.taskId)! + 1);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: TaskId[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const succ of successors.get(id)!) {
      const d = indegree.get(succ)! - 1;
      indegree.set(succ, d);
      if (d === 0) insertSorted(ready, succ);
    }
  }
  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id));
    throw new DubError(GANTT_CALC_DEPENDENCY_CYCLE, "dependency cycle detected", {
      status: 422,
      details: { cycles: findCycles(remaining, dependencies) },
    });
  }
  return order;
}

function insertSorted(arr: TaskId[], value: TaskId): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

/** Non-throwing validator: reports cycles + unknown refs (task-service -> 409). */
export function validateDependencies(req: ValidateDependenciesRequest): ValidateDependenciesResponse {
  const known = new Set(req.taskIds);
  const unknown = new Set<TaskId>();
  for (const dep of req.dependencies) {
    if (!known.has(dep.taskId)) unknown.add(dep.taskId);
    if (!known.has(dep.dependsOnId)) unknown.add(dep.dependsOnId);
  }
  const cycles = findCycles([...req.taskIds], req.dependencies);
  return {
    valid: cycles.length === 0 && unknown.size === 0,
    cycles,
    unknownTaskIds: [...unknown].sort(),
  };
}

/** Tarjan SCC — returns every strongly connected component of size > 1 (plus
 *  self-loops) as an ordered id list. Deterministic (nodes visited id asc). */
function findCycles(taskIds: TaskId[], dependencies: Dependency[]): TaskId[][] {
  const nodes = [...new Set(taskIds)].sort();
  const known = new Set(nodes);
  const adj = new Map<TaskId, TaskId[]>();
  for (const id of nodes) adj.set(id, []);
  const selfLoops: TaskId[][] = [];
  for (const dep of dependencies) {
    if (!known.has(dep.dependsOnId) || !known.has(dep.taskId)) continue;
    if (dep.dependsOnId === dep.taskId) selfLoops.push([dep.taskId]);
    else adj.get(dep.dependsOnId)!.push(dep.taskId);
  }
  for (const [, outs] of adj) outs.sort();

  let index = 0;
  const idx = new Map<TaskId, number>();
  const low = new Map<TaskId, number>();
  const onStack = new Set<TaskId>();
  const stack: TaskId[] = [];
  const sccs: TaskId[][] = [];

  const strongconnect = (v: TaskId): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)!) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: TaskId[] = [];
      let w: TaskId;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.reverse());
    }
  };

  for (const v of nodes) if (!idx.has(v)) strongconnect(v);
  return [...selfLoops, ...sccs];
}
