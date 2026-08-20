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

// ── send / receive: cross-team task requests + cross-links ───────────────────
// The "送る・受け取る" feature. Same-team work stays arrow-linked dependencies
// (task_dependencies); cross-team work is a request → approval → cross-link that
// draws NO arrow. All additive to the frozen Task shape (new tables + interfaces).
// Design SoT: docs/design/send-receive-task-requests.md / ADR-0007.

/**
 * Reason codes a `PUT /tasks/:id/dependencies` rejection can carry in the
 * VALIDATION_FAILED FieldError[]. `cross_team_not_allowed` = a dependsOn target
 * whose `teamId` differs from the current task's (both `null` counts as the same
 * "no team" bucket; one-sided null is a mismatch). Server门番 (Feature 1) and its
 * regression test derive the literal from here so neither can drift (no duplicate
 * string). `self_dependency`/`unknown_task_ref` are the pre-existing reasons.
 */
export const DEPENDENCY_REJECT_REASONS = {
  crossTeamNotAllowed: "cross_team_not_allowed",
  selfDependency: "self_dependency",
  unknownTaskRef: "unknown_task_ref",
} as const;
export type DependencyRejectReason =
  (typeof DEPENDENCY_REJECT_REASONS)[keyof typeof DEPENDENCY_REJECT_REASONS];

export type TaskRequestState = "pending" | "accepted" | "declined" | "cancelled";

/** A cross-team task request (task_requests). Carries the approval state; a task
 *  only materialises for the receiver's team once it is `accepted`. */
export interface TaskRequest extends Versioned {
  id: string; // treq_ ULID
  eventId?: EventId | null;
  fromUserId: UserId; // 依頼者 (createdBy)
  toUserId: UserId; // 受け手 (承認後の assignee)
  fromTeamId?: TeamId | null;
  toTeamId?: TeamId | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueAt: ISODateTime | null;
  sourceTaskId?: TaskId | null; // 依頼者側の追跡タスク (無ければ承認で自動生成)
  state: TaskRequestState;
  declineReason?: string | null;
  createdTaskId?: TaskId | null; // 承認で生まれた受け手タスク
  createdAt: ISODateTime;
  decidedAt: ISODateTime | null;
  updatedAt: ISODateTime;
}

/** Body of POST /task-requests. The destination's team membership is resolved
 *  server-side (self / same-team → immediate task; other team → pending request);
 *  any client-side team hint is UX-only and never trusted. */
export interface IssueTaskRequestBody {
  toUserId: UserId;
  title: string;
  description?: string | null;
  priority?: TaskPriority; // default "medium"
  dueAt?: ISODateTime | null;
  eventId?: EventId | null;
  sourceTaskId?: TaskId | null; // omit ⇒ auto-generated on accept
  targetTeamId?: TeamId | null; // when the receiver belongs to multiple teams
}

/** Discriminated result of POST /task-requests so the caller can tell whether the
 *  request became a task immediately (self / same-team) or is awaiting approval. */
export type IssueTaskRequestResponse =
  | { kind: "task"; task: Task } // self / same-team → materialised now
  | { kind: "request"; request: TaskRequest }; // other team → pending approval

export interface AcceptTaskRequestBody extends Versioned {
  targetTeamId?: TeamId | null; // receiver picks the owning team at accept-time
}
export interface DeclineTaskRequestBody extends Versioned {
  reason?: string;
}
export type CancelTaskRequestBody = Versioned;

export interface ListTaskRequestsQuery extends CursorQuery {
  box: "incoming" | "outgoing"; // incoming = to_user=self / outgoing = from_user=self
  state?: TaskRequestState[];
  eventId?: EventId;
}
export type ListTaskRequestsResponse = Paginated<TaskRequest>;

/** Result of POST /task-requests/:id/accept — the receiver's new task, the
 *  requester's tracking task link, and the arrow-less cross-link joining them. */
export interface AcceptTaskRequestResponse {
  request: TaskRequest;
  createdTask: Task; // 受け手チームに生まれたタスク (受け負った側)
  crossLink: TaskCrossLink;
}

/** Role a task plays in a cross-team link. `requested` = the "お願いした" side
 *  (requester), `accepted` = the "受け負った" side (receiver). The status label is
 *  DERIVED from this role (never stored) so it is always in sync + i18n-swappable. */
export type TaskCrossRole = "requested" | "accepted";

/** Auto-generated cross-team status label, derived from role (never persisted).
 *  Single source for the「タスクをお願いした / 受け負った」wording both views render. */
export const TASK_CROSS_ROLE_STATUS_LABEL: Record<TaskCrossRole, string> = {
  requested: "タスクをお願いした",
  accepted: "タスクを受け負った",
};

/** An arrow-less cross-team link (task_cross_links). NOT a dependency — it never
 *  enters task_dependencies, so gantt draws no line and CPM never sees it. */
export interface TaskCrossLink {
  id: string; // txl_ ULID
  requestId: string;
  requesterTaskId: TaskId; // お願いした側
  requesteeTaskId: TaskId; // 受け負った側
  eventId?: EventId | null;
  createdAt: ISODateTime;
}
export interface ListTaskCrossLinksQuery {
  eventId: EventId; // required (same shape as GET /tasks/dependencies)
}
export interface ListTaskCrossLinksResponse {
  items: TaskCrossLink[];
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* the send/receive read
// endpoints put on the wire. The FE client (apps/fe4 endpoints.ts), the server
// (task-service), and the OpenAPI spec (docs/openapi/task-service.yaml) all derive
// from — and are reconciled against — this one map. Keyed by operationId to match
// the spec. `path` is the gateway path AFTER the /api/v1 prefix strip. Endpoints
// with no query carry `query: []` so the descriptor still documents method+path.
// See docs/api-contracts/_wire-contract-enforcement.md — do not hand-map keys.
export const TASK_REQUEST_WIRE = {
  issueTaskRequest: { method: "POST", path: "/task-requests", query: [] },
  listTaskRequests: {
    method: "GET",
    path: "/task-requests",
    query: ["cursor", "limit", "box", "state", "eventId"],
  },
  getTaskRequest: { method: "GET", path: "/task-requests/{id}", query: [] },
  acceptTaskRequest: { method: "POST", path: "/task-requests/{id}/accept", query: [] },
  declineTaskRequest: { method: "POST", path: "/task-requests/{id}/decline", query: [] },
  cancelTaskRequest: { method: "POST", path: "/task-requests/{id}/cancel", query: [] },
  listTaskCrossLinks: { method: "GET", path: "/tasks/cross-links", query: ["eventId"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type,
// so the runtime descriptor and the hand-written query interfaces can never drift.
type _TaskRequestWireKeysAreTyped =
  (typeof TASK_REQUEST_WIRE.listTaskRequests.query)[number] extends keyof ListTaskRequestsQuery
    ? (typeof TASK_REQUEST_WIRE.listTaskCrossLinks.query)[number] extends keyof ListTaskCrossLinksQuery
      ? true
      : never
    : never;
const _taskRequestWireKeyGuard: _TaskRequestWireKeysAreTyped = true;
void _taskRequestWireKeyGuard;
