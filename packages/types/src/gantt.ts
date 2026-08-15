// gantt — gantt-service namespace (view states; read model over task/event).
import type { EventId, TaskId, UserId, TeamId, ISODateTime } from "./common";

export type GanttZoom = "day" | "week" | "month";

export interface GanttRow {
  taskId: TaskId;
  title: string;
  startsAt: ISODateTime | null;
  endsAt: ISODateTime | null;
  progressPercent: number; // 0-100 (done=100/else=0 in P0)
  assigneeId: UserId | null;
  /** Owning team (canonical team.Team), for team-scoped views. Additive. */
  teamId?: TeamId | null;
  /** WBS hierarchy (all additive/optional; absent ⇒ a flat top-level row).
   *  A row whose `parentTaskId` points at another row is a child (WBS leaf) of
   *  that work-package; the UI indents it and hides it when the parent collapses. */
  parentTaskId?: TaskId | null;
  /** Depth in the WBS tree: 0 = work-package (top-level), 1 = leaf. */
  depth?: number;
  /** True when at least one other row lists this row as its `parentTaskId`
   *  (the UI renders a collapse/expand toggle for it). */
  hasChildren?: boolean;
  /** WBS code (e.g. "4.9.3"), for stable ordering + a legible row label. */
  wbs?: string;
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
  /** Zero-slack tasks on the critical path (CPM over durations+FS deps). Optional
   *  & additive: absent/[] means "not computed" — UI colors these bars distinctly. */
  criticalTaskIds?: TaskId[];
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
