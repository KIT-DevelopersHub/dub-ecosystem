// ganttCalc — gantt-calc namespace (pure computation; HTTP /validate removed,
// validateDependencies is imported as a pure function by task-service).
import type { TaskId, ISODateTime } from "./common";

export interface GanttCalcTask {
  id: TaskId;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  durationDays: number;
}
// Dependency kind (PDM/CPM). Predecessor = dependsOnId, successor = taskId.
//   FS finish-to-start  — successor starts after predecessor finishes (default)
//   SS start-to-start   — successor starts after predecessor starts
//   FF finish-to-finish — successor finishes after predecessor finishes
//   SF start-to-finish  — successor finishes after predecessor starts
export type GanttCalcDependencyKind = "FS" | "SS" | "FF" | "SF";

export interface GanttCalcDependency {
  taskId: TaskId;
  dependsOnId: TaskId;
  // Omitted => FS (backward compatible with the P0b frozen shape).
  kind?: GanttCalcDependencyKind;
  // Lag (positive) / lead (negative) applied to the relation. Integer days;
  // interpreted as working days when a WorkCalendar is supplied, else calendar
  // days. Omitted => 0.
  lagDays?: number;
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
