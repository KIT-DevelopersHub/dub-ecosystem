// gantt — gantt-service namespace (view states; read model over task/event).
import type { EventId, TaskId, UserId, ISODateTime } from "./common";

export type GanttZoom = "day" | "week" | "month";

export interface GanttRow {
  taskId: TaskId;
  title: string;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  progressPercent: number; // 0-100 (done=100/else=0 in P0)
  assigneeId: UserId | null;
}

export interface GanttDependencyLine {
  id: string; // composite key `${taskId}->${dependsOnId}`
  fromTaskId: TaskId;
  toTaskId: TaskId;
  type: "FS"; // P0 constant fill
  lagDays: number; // P0 constant 0
}

export interface GanttChartDTO {
  eventId: EventId;
  rows: GanttRow[];
  dependencies: GanttDependencyLine[];
}

export interface GanttViewState {
  eventId: EventId;
  zoom: GanttZoom;
  collapsedTaskIds: TaskId[];
}
export interface GetGanttQuery {
  eventId: EventId;
}
export interface PutGanttViewRequest {
  zoom: GanttZoom;
  collapsedTaskIds: TaskId[];
}
