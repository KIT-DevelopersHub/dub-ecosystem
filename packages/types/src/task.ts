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
  eventId: EventId;
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
  eventId: EventId;
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
