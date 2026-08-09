// ganttCalc — gantt-calc namespace (pure computation; HTTP /validate removed,
// validateDependencies is imported as a pure function by task-service).
import type { TaskId, ISODateTime } from "./common";

export interface GanttCalcTask {
  id: TaskId;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  durationDays: number;
}
export interface GanttCalcDependency {
  taskId: TaskId;
  dependsOnId: TaskId;
}

export interface RollupRequest {
  tasks: GanttCalcTask[];
  dependencies: GanttCalcDependency[];
}
export interface RollupResponse {
  earliestStart: Record<TaskId, ISODateTime>;
  latestFinish: Record<TaskId, ISODateTime>;
}
export interface CriticalPathRequest {
  tasks: GanttCalcTask[];
  dependencies: GanttCalcDependency[];
}
export interface CriticalPathResponse {
  criticalTaskIds: TaskId[];
  totalDurationDays: number;
}
