// task — task-service namespace. Optimistic-locked CRUD; task_dependencies owned here.
import type { TaskId, EventId, UserId, TeamId, ISODateTime, Versioned, Paginated, CursorQuery } from "./common";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled"; // closed (D6)
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskOrigin = "internal" | "github";

// Status transition table (server validation + FE4 UI activation single source).
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["todo", "blocked", "done", "cancelled"],
  blocked: ["todo", "in_progress", "cancelled"], // done only via in_progress
  done: ["in_progress"], // reopen
  cancelled: ["todo"], // reopen
};

export interface Task extends Versioned {
  id: TaskId;
  /**
   * Optional event linkage. A task MAY belong to an event (e.g. 北陸ITカンファレンス)
   * but is not required to — `null`/absent means an unlinked, standalone task. The
   * Event entity itself still exists (event-service / FE3); only the task→event
   * coupling is optional now. (判断44: keep the concept, make the link optional.)
   */
  eventId?: EventId | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: UserId | null;
  /** Owning team (canonical team.Team). Additive; null = unassigned to a team. */
  teamId?: TeamId | null;
  /**
   * Requester — the user who issued (created) the task. This is the "from" in the
   * from→to relationship the My Tasks hub renders (createdBy → assigneeId). Server
   * always populates it (task_tasks.created_by, NOT NULL); typed optional so the
   * many existing Task literals across the monorepo need not be touched (additive).
   */
  createdBy?: UserId;
  dueAt: ISODateTime | null;
  origin: TaskOrigin;
  archivedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface TaskSummary {
  id: TaskId;
  title: string;
  status: TaskStatus;
  assigneeId: UserId | null;
}

// Composite-PK dependency (frozen shape). task-service is sole owner.
export interface TaskDependency {
  taskId: TaskId;
  dependsOnId: TaskId;
}

export interface CreateTaskRequest {
  /** Optional event linkage (see Task.eventId). Omit to issue an unlinked task. */
  eventId?: EventId;
  title: string;
  description?: string;
  priority?: TaskPriority; // default "medium"
  assigneeId?: UserId;
  teamId?: TeamId | null;
  dueAt?: ISODateTime;
  origin?: TaskOrigin; // default "internal"; service-role only, else 400
}
export interface UpdateTaskRequest extends Versioned {
  title?: string;
  description?: string | null;
  status?: TaskStatus; // validated against TASK_STATUS_TRANSITIONS
  priority?: TaskPriority;
  assigneeId?: UserId | null;
  teamId?: TeamId | null;
  dueAt?: ISODateTime | null;
}
export interface ReplaceDependenciesRequest extends Versioned {
  dependsOnIds: TaskId[];
}
export interface ListTasksQuery extends CursorQuery {
  eventId?: EventId;
  status?: TaskStatus[];
  assigneeId?: UserId;
  /** Requester filter — tasks issued (created) by this user. Powers the "依頼" lens. */
  createdById?: UserId;
  teamId?: TeamId;
  includeArchived?: boolean;
}
export type ListTasksResponse = Paginated<Task>;
