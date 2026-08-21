// Typed thin wrappers over the FE2 ApiClient. Every call is expressed against
// `@dub/types` and mounted under the frozen `/api/v1` prefix (common.API_PREFIX).
// Query-parameter names come from the @dub/types wire contract (e.g. gantt.GetGanttQuery,
// task.ListTasksQuery) — NEVER hand-renamed here. gantt uses `eventId`, same as task:
// the old `?event=` here silently disagreed with the server's `?eventId=` and shipped a
// prod "Validation failed". A contract-conformance test now reconciles these keys in CI.
import type { task, gantt, identity, event, common, team, member } from "@dub/types";
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

/** Restore (un-archive) a soft-deleted task — the inverse of deleteTask, used by the
 *  gantt "削除を元に戻す" (Ctrl/⌘-Z) undo. Returns the restored task (archived_at cleared,
 *  parent/assignee/dependencies intact). Idempotent server-side (restoring a live task
 *  is a no-op that echoes the live task). */
export function restoreTask(client: ApiClient, id: common.TaskId): Promise<task.Task> {
  return client.request<task.Task>({ method: "POST", path: `${P}/tasks/${id}/restore` as ApiPath });
}

// ---- task attachments (task-service; task_attachments) ----
export function listTaskAttachments(
  client: ApiClient,
  taskId: common.TaskId,
): Promise<task.ListTaskAttachmentsResponse> {
  return client.request<task.ListTaskAttachmentsResponse>({
    method: "GET",
    path: `${P}/tasks/${taskId}/attachments` as ApiPath,
  });
}

export function createTaskAttachment(
  client: ApiClient,
  taskId: common.TaskId,
  body: task.CreateTaskAttachmentRequest,
): Promise<task.TaskAttachment> {
  return client.request<task.TaskAttachment>({
    method: "POST",
    path: `${P}/tasks/${taskId}/attachments` as ApiPath,
    body,
  });
}

export function deleteTaskAttachment(
  client: ApiClient,
  taskId: common.TaskId,
  attachmentId: string,
): Promise<void> {
  return client.request<void>({
    method: "DELETE",
    path: `${P}/tasks/${taskId}/attachments/${attachmentId}` as ApiPath,
  });
}

/** Wire response of PUT /tasks/:id/dependencies. The server returns ONLY this
 *  (NOT a full task.Task) — it bumps the task's version internally but does not
 *  echo it back, so callers must NOT read `.version` here and should re-fetch the
 *  task (getTask) when a fresh version is needed for a chained write. */
export interface ReplaceDependenciesResult {
  taskId: common.TaskId;
  dependsOnIds: common.TaskId[];
}

export function replaceDependencies(
  client: ApiClient,
  id: common.TaskId,
  body: task.ReplaceDependenciesRequest,
): Promise<ReplaceDependenciesResult> {
  return client.request<ReplaceDependenciesResult>({
    method: "PUT",
    path: `${P}/tasks/${id}/dependencies` as ApiPath,
    body,
  });
}

// ---- gantt-service (read-only; query key from gantt.GetGanttQuery = `eventId`) ----
// Build the query object AS the typed contract so its keys are the SoT field names; a
// renamed key (the old `event`) can no longer be introduced without a type error here.
export function getGantt(client: ApiClient, eventId: common.EventId): Promise<gantt.GanttChartDTO> {
  // edit直後の再取得はキャッシュをバイパス (design §2-2 / test 6)
  const query: gantt.GetGanttQuery = { eventId };
  return client.request<gantt.GanttChartDTO>({
    method: "GET",
    path: `${P}/gantt`,
    query: { ...query },
  });
}

export function getGanttFresh(client: ApiClient, eventId: common.EventId): Promise<gantt.GanttChartDTO> {
  const query: gantt.GetGanttQuery = { eventId };
  return client.request<gantt.GanttChartDTO>({
    method: "GET",
    path: `${P}/gantt`,
    query: { ...query },
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
  const query: gantt.GetGanttQuery = { eventId };
  return client.request<gantt.GanttDependencyLine[]>({
    method: "GET",
    path: `${P}/gantt/dependencies`,
    query: { ...query },
  });
}

export function getGanttView(client: ApiClient, eventId: common.EventId): Promise<gantt.GanttViewState> {
  const query: gantt.GetGanttQuery = { eventId };
  return client.request<gantt.GanttViewState>({
    method: "GET",
    path: `${P}/gantt/views`,
    query: { ...query },
  });
}

export function putGanttView(
  client: ApiClient,
  eventId: common.EventId,
  body: gantt.PutGanttViewRequest,
): Promise<gantt.GanttViewState> {
  const query: gantt.GetGanttQuery = { eventId };
  return client.request<gantt.GanttViewState>({
    method: "PUT",
    path: `${P}/gantt/views`,
    query: { ...query },
    body,
  });
}

// ---- teams (canonical team.Team). Single fetch source: swap this to the
//      member-service team list API later without touching consumers. ----
export function listTeams(client: ApiClient): Promise<member.ListTeamsResponse> {
  // Canonical team list is owned by member-service and exposed at the gateway
  // "members" segment (GET /api/v1/members/teams). The api-gateway has NO bare
  // "teams" segment, so `${P}/teams` 404s in prod — which silently emptied the
  // gantt team switcher/legend. Route through /members/teams (the real source).
  // member-service's canonical envelope is { teams: Team[] } (member.ListTeamsResponse),
  // NOT { items } — the mock previously returned { items }, so the switcher rendered
  // locally but stayed empty in prod. Consume the real shape here.
  return client.request<member.ListTeamsResponse>({ method: "GET", path: `${P}/members/teams` });
}

/**
 * Members overview (member-service): the 運営メンバー roster WITH their team memberships
 * and identity-account links. Used to seed 「タスクを発行」's チーム default to the team the
 * logged-in user belongs to (matched via member.identityUserId === current userId). Same
 * source the 名簿 screens read (GET /api/v1/members/overview). Best-effort at the call site.
 */
export function getMembersOverview(client: ApiClient): Promise<member.MembersOverview> {
  return client.request<member.MembersOverview>({ method: "GET", path: `${P}/members/overview` });
}

/**
 * Adapt member-service's wire Team ({ color/description: string | null }) to the fe4
 * domain team.Team ({ color/description?: string }). Every fe4 consumer (switcher,
 * legend, selects) speaks team.Team; centralizing the unwrap+normalize here keeps the
 * mock and prod on one shape.
 */
export function toDomainTeams(res: member.ListTeamsResponse): team.Team[] {
  return res.teams.map((t) => ({
    id: t.id as common.TeamId,
    key: t.key,
    name: t.name,
    ...(t.color != null ? { color: t.color } : {}),
    // Carry the team's 2-letter ID-prefix code through so numbering can use an
    // explicit member-service code (falls back to the canonical key map when absent).
    ...(t.code != null ? { code: t.code } : {}),
    ...(t.description != null ? { description: t.description } : {}),
  }));
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

/** List the org roster (member names) so an assignee can be picked from real
 *  members — not only users already assigned to some task. Same endpoint as
 *  resolveUsers but WITHOUT `ids` (list mode); scoped to active members. */
export function listRosterUsers(
  client: ApiClient,
  opts: { status?: identity.UserStatus; limit?: number; q?: string } = {},
): Promise<common.Paginated<identity.UserSummary>> {
  return client.request<common.Paginated<identity.UserSummary>>({
    method: "GET",
    path: `${P}/identity/users`,
    query: {
      status: opts.status ?? "active",
      limit: opts.limit ?? 200,
      ...(opts.q ? { q: opts.q } : {}),
    },
  });
}

/** List the 運営メンバー roster (no `ids` filter ⇒ the full member list) — powers the
 *  「タスクを発行」 依頼先(担当者) dropdown so a requester can pick any member, not just
 *  those already referenced by existing tasks. Degrades gracefully: callers fall back
 *  to the task-derived people when this yields nothing / is unsupported. */
export function listRoster(client: ApiClient): Promise<common.Paginated<identity.UserSummary>> {
  return client.request<common.Paginated<identity.UserSummary>>({
    method: "GET",
    path: `${P}/identity/users`,
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
