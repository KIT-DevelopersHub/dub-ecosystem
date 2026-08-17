// Typed thin wrappers over the FE2 ApiClient. Every call is expressed against
// `@dub/types` and mounted under the frozen `/api/v1` prefix (common.API_PREFIX).
// task uses `eventId`; gantt uses `event` (design §2-3 — kept per each owner's
// contract,取り違え防止 is the client path/type surface).
import type { task, gantt, identity, event, common, team } from "@dub/types";
import type { ApiClient, ApiPath } from "../contracts/spa-shell";

const P = "/api/v1"; // === common.API_PREFIX (kept literal for ApiPath template)

// ---- task-service ----
export function listTasks(client: ApiClient, q: task.ListTasksQuery): Promise<task.ListTasksResponse> {
  return client.request<task.ListTasksResponse>({
    method: "GET",
    path: `${P}/tasks`,
    query: {
      ...(q.eventId !== undefined ? { eventId: q.eventId } : {}),
      ...(q.assigneeId !== undefined ? { assigneeId: q.assigneeId } : {}),
      ...(q.createdById !== undefined ? { createdById: q.createdById } : {}),
      ...(q.teamId !== undefined ? { teamId: q.teamId } : {}),
      ...(q.status !== undefined ? { status: q.status.join(",") } : {}),
      ...(q.includeArchived !== undefined ? { includeArchived: q.includeArchived } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    },
  });
}

export function getTask(client: ApiClient, id: common.TaskId): Promise<task.Task> {
  return client.request<task.Task>({ method: "GET", path: `${P}/tasks/${id}` as ApiPath });
}

export function createTask(client: ApiClient, body: task.CreateTaskRequest): Promise<task.Task> {
  return client.request<task.Task>({ method: "POST", path: `${P}/tasks`, body });
}

export function updateTask(
  client: ApiClient,
  id: common.TaskId,
  body: task.UpdateTaskRequest,
): Promise<task.Task> {
  return client.request<task.Task>({ method: "PATCH", path: `${P}/tasks/${id}` as ApiPath, body });
}

export function deleteTask(client: ApiClient, id: common.TaskId): Promise<void> {
  return client.request<void>({ method: "DELETE", path: `${P}/tasks/${id}` as ApiPath });
}

export function replaceDependencies(
  client: ApiClient,
  id: common.TaskId,
  body: task.ReplaceDependenciesRequest,
): Promise<task.Task> {
  return client.request<task.Task>({
    method: "PUT",
    path: `${P}/tasks/${id}/dependencies` as ApiPath,
    body,
  });
}

// ---- gantt-service (read-only; `?eventId=`) ----
// gantt-service reads the event query param as `eventId` (requireEventId + the
// event:read permission scope). The client formerly sent `?event=` which the live
// gantt-service never read, so every prod gantt load 400'd "eventId is required"
// (surfaced as a "Validation failed" banner). Unified on `eventId` here.
export function getGantt(client: ApiClient, eventId: common.EventId): Promise<gantt.GanttChartDTO> {
  // edit直後の再取得はキャッシュをバイパス (design §2-2 / test 6)
  return client.request<gantt.GanttChartDTO>({
    method: "GET",
    path: `${P}/gantt`,
    query: { eventId },
  });
}

export function getGanttFresh(client: ApiClient, eventId: common.EventId): Promise<gantt.GanttChartDTO> {
  return client.request<gantt.GanttChartDTO>({
    method: "GET",
    path: `${P}/gantt`,
    query: { eventId },
    headers: { "Cache-Control": "no-cache" },
  });
}

/** Persist a bar's schedule after a timeline drag/resize (Notion-style edit). */
export function patchGanttRow(
  client: ApiClient,
  taskId: common.TaskId,
  body: { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
): Promise<gantt.GanttRow> {
  return client.request<gantt.GanttRow>({
    method: "PATCH",
    path: `${P}/gantt/rows/${taskId}` as ApiPath,
    body,
  });
}

export function getGanttDependencies(
  client: ApiClient,
  eventId: common.EventId,
): Promise<gantt.GanttDependencyLine[]> {
  return client.request<gantt.GanttDependencyLine[]>({
    method: "GET",
    path: `${P}/gantt/dependencies`,
    query: { eventId },
  });
}

export function getGanttView(client: ApiClient, eventId: common.EventId): Promise<gantt.GanttViewState> {
  return client.request<gantt.GanttViewState>({
    method: "GET",
    path: `${P}/gantt/views`,
    query: { eventId },
  });
}

export function putGanttView(
  client: ApiClient,
  eventId: common.EventId,
  body: gantt.PutGanttViewRequest,
): Promise<gantt.GanttViewState> {
  return client.request<gantt.GanttViewState>({
    method: "PUT",
    path: `${P}/gantt/views`,
    query: { eventId },
    body,
  });
}

// ---- teams (canonical team.Team). Single fetch source: swap this to the
//      member-service team list API later without touching consumers. ----
export function listTeams(client: ApiClient): Promise<team.ListTeamsResponse> {
  // Canonical team list is owned by member-service and exposed at the gateway
  // "members" segment (GET /api/v1/members/teams). The api-gateway has NO bare
  // "teams" segment, so `${P}/teams` 404s in prod — which silently emptied the
  // gantt team switcher/legend. Route through /members/teams (the real source).
  return client.request<team.ListTeamsResponse>({ method: "GET", path: `${P}/members/teams` });
}

// ---- identity-roster (batch user resolve; ?ids=, max 50) ----
export const USER_BATCH_MAX = 50;

export function resolveUsers(
  client: ApiClient,
  ids: readonly common.UserId[],
): Promise<common.Paginated<identity.UserSummary>> {
  return client.request<common.Paginated<identity.UserSummary>>({
    method: "GET",
    path: `${P}/identity/users`,
    query: { ids: ids.join(",") },
  });
}

// ---- event-service (event picker for タスク発行 + create/edit form choices) ----
// The マイタスク hub needs the live event list so 「タスクを発行」 can pick a 対象
// イベント (task-service requires a real eventId on POST /tasks). Default page is
// enough to populate the picker; the shell falls back to task-derived events.
export function listEvents(client: ApiClient): Promise<event.ListEventsResponse> {
  return client.request<event.ListEventsResponse>({ method: "GET", path: `${P}/events` });
}

export function listEventActions(
  client: ApiClient,
  eventId: common.EventId,
): Promise<event.ActionSummary[]> {
  return client.request<event.ActionSummary[]>({
    method: "GET",
    path: `${P}/events/${eventId}/actions` as ApiPath,
  });
}
