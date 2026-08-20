// task — task-service namespace. Optimistic-locked CRUD; task_dependencies owned here.
import type { TaskId, EventId, UserId, TeamId, FileId, ISODateTime, Versioned, Paginated, CursorQuery } from "./common";

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
  /** WBS parent (親タスク). Additive/optional; null/absent ⇒ a top-level row. The
   *  gantt read model projects this onto GanttRow.parentTaskId to build the tree. */
  parentTaskId?: TaskId | null;
  /** WBS code (e.g. "4.9.3") — stable ordering + a legible label. Additive/optional. */
  wbs?: string | null;
  /**
   * Requester — the user who issued (created) the task. This is the "from" in the
   * from→to relationship the My Tasks hub renders (createdBy → assigneeId). Server
   * always populates it (task_tasks.created_by, NOT NULL); typed optional so the
   * many existing Task literals across the monorepo need not be touched (additive).
   */
  createdBy?: UserId;
  /**
   * Planned start (開始日). Additive/optional; null/absent ⇒ no explicit start — the
   * gantt read model then derives a bar from `dueAt` (deadline-anchored) or a CPM
   * schedule. When BOTH `startAt` and `dueAt` are set the bar spans exactly
   * [startAt, dueAt], so a dateless task can be given a real, arrow-linkable bar.
   */
  startAt?: ISODateTime | null;
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
  /** Planned start (開始日). Additive/optional; omit ⇒ no explicit start. */
  startAt?: ISODateTime | null;
  dueAt?: ISODateTime;
  origin?: TaskOrigin; // default "internal"; service-role only, else 400
  /** WBS parent (親タスク). Additive/optional; omit or null ⇒ a top-level row.
   *  The gantt read model projects this onto GanttRow.parentTaskId. */
  parentTaskId?: TaskId | null;
  /** WBS code (e.g. "4.9.3"). Additive/optional. */
  wbs?: string | null;
}
export interface UpdateTaskRequest extends Versioned {
  title?: string;
  description?: string | null;
  status?: TaskStatus; // validated against TASK_STATUS_TRANSITIONS
  priority?: TaskPriority;
  assigneeId?: UserId | null;
  teamId?: TeamId | null;
  /** Planned start (開始日). Additive/optional; omit ⇒ unchanged, null ⇒ clear. */
  startAt?: ISODateTime | null;
  dueAt?: ISODateTime | null;
  /** Re-parent (親子関係の変更) — set to another task id, or null to detach to
   *  top-level. Additive/optional; omit ⇒ parent unchanged. */
  parentTaskId?: TaskId | null;
  /** WBS code (e.g. "4.9.3"). Additive/optional; omit ⇒ unchanged. */
  wbs?: string | null;
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

// ── task attachments (task_attachments; task-service owns) ────────────────────
// A task's 内容 can carry attachments: an uploaded file (blob stored in file-meta
// / R2; `fileId` + `url` download path denormalized for one-shot display) or an
// external URL (`kind:"url"`, `fileId:null`). Additive to the frozen Task shape.
export type TaskAttachmentKind = "file" | "url";
export interface TaskAttachment {
  id: string;
  taskId: TaskId;
  kind: TaskAttachmentKind;
  /** display label (file name, or a caption for a url). */
  name: string;
  /** file: the file-meta download path; url: the external URL. */
  url: string;
  /** file-meta file id when kind="file"; null for a plain url. */
  fileId: FileId | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdBy: UserId;
  createdAt: ISODateTime;
}
export interface CreateTaskAttachmentRequest {
  kind: TaskAttachmentKind;
  name: string;
  url: string;
  fileId?: FileId;
  mimeType?: string;
  sizeBytes?: number;
}
export interface ListTaskAttachmentsResponse {
  items: TaskAttachment[];
}

// ── dependency rejection reasons (cross-scope deps / ADR-0006) ────────────────
/**
 * Reason codes a `PUT /tasks/:id/dependencies` rejection can carry in the
 * VALIDATION_FAILED FieldError[]. `cross_team_not_allowed` = a dependsOn target whose
 * `teamId` differs from the current task's (both `null` counts as the same "no team"
 * bucket; one-sided null is a mismatch). Dependencies may now span different WBS scopes
 * (別階層) freely — the TEAM is the only boundary. Server门番 and its regression test
 * derive the literal from here so neither can drift (no duplicate string).
 * `self_dependency`/`unknown_task_ref` are the pre-existing reasons.
 */
export const DEPENDENCY_REJECT_REASONS = {
  crossTeamNotAllowed: "cross_team_not_allowed",
  selfDependency: "self_dependency",
  unknownTaskRef: "unknown_task_ref",
} as const;
export type DependencyRejectReason =
  (typeof DEPENDENCY_REJECT_REASONS)[keyof typeof DEPENDENCY_REJECT_REASONS];
