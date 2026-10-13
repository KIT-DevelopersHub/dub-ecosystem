// Calendar feature api adapter. The calendar is a NEW VIEW over the SAME task
// data the マイタスク list (FE4) and the ガントチャート read — it owns no backend
// contract of its own. It rides the ONE shell api-client (src/lib/api-client.tsx:
// session cookie, 401→refresh, requestId, error normalization) and calls the
// canonical task-service endpoint GET /api/v1/tasks, typed against @dub/types
// `task` (the API-contract SoT). No schema is added or changed. Writes (予定の追加/編集/削除) use the same
// task-service create/update/archive endpoints マイタスク uses.
import type { common, identity, meeting, task } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

const P = "/api/v1";
/** Server page size; the calendar pages through to load a whole month's tasks. */
const PAGE_LIMIT = 100;
/** Safety cap so a broken cursor can never loop forever. */
const MAX_PAGES = 20;

export interface CalendarTaskQuery {
  /** Optional event scope (kept null/omitted = all tasks visible to the user). */
  eventId?: common.EventId;
  /** Optional assignee scope (担当 — tasks assigned to a user). */
  assigneeId?: common.UserId;
  /** Optional issuer scope (依頼 — tasks created by a user). */
  createdById?: common.UserId;
  /** Optional team scope. */
  teamId?: common.TeamId;
  /** Include archived (default false — the calendar hides archived anyway). */
  includeArchived?: boolean;
}

export interface CalendarApi {
  /** One page of tasks (mirrors task-service GET /api/v1/tasks). */
  listTasks(query?: CalendarTaskQuery & common.CursorQuery): Promise<task.ListTasksResponse>;
  /** Convenience: page through and return every task matching the query. */
  listAllTasks(query?: CalendarTaskQuery): Promise<task.Task[]>;
  /**
   * Every task the caller OWNS — assigned to them (担当, assigneeId=self) OR issued
   * by them (依頼, createdById=self) — merged and de-duped by id. This mirrors
   * マイタスク's「すべて」lens and is the ONLY event-less task list task-service lets a
   * user read: a bare GET /tasks (no eventId, not self-scoped) is rejected 400 by the
   * "/me rule" (task-service app.ts), which is exactly why the calendar's old
   * `listAllTasks()` with no scope failed in production ("タスクを取得できませんでした。").
   */
  listMyTasks(currentUserId: common.UserId): Promise<task.Task[]>;
  /** 予定の追加 — a calendar 予定 is a task with startAt/dueAt (POST /api/v1/tasks). */
  createTask(req: task.CreateTaskRequest): Promise<task.Task>;
  updateTask(id: common.TaskId, req: task.UpdateTaskRequest): Promise<task.Task>;
  /** Archives the task (task-service DELETE is a soft delete). */
  deleteTask(id: common.TaskId): Promise<void>;
  /** Every org role (GET /identity/roles, identity:read) — the 予定 label choices. */
  listRoles(): Promise<identity.Role[]>;
  /** Display names for the given users (GET /identity/users?ids=, identity:read). */
  getUsers(ids: readonly common.UserId[]): Promise<identity.UserSummary[]>;

  // カレンダー > ミーティング (drive-share-service /meetings, @dub/types meeting).
  listMeetings(): Promise<meeting.ListMeetingsResponse>;
  listMeetingTargets(): Promise<meeting.ListMeetingTargetsResponse>;
  createMeeting(body: meeting.CreateMeetingRequest): Promise<meeting.Meeting>;
  updateMeeting(id: string, body: meeting.UpdateMeetingRequest): Promise<meeting.Meeting>;
  deleteMeeting(id: string): Promise<void>;
  syncMeetings(): Promise<meeting.SyncMeetingsResponse>;
}

export function createCalendarApi(api: ApiClient): CalendarApi {
  const listTasks: CalendarApi["listTasks"] = (query = {}) =>
    api.request<task.ListTasksResponse>({
      method: "GET",
      path: `${P}/tasks`,
      query: {
        ...(query.eventId !== undefined ? { eventId: query.eventId } : {}),
        ...(query.assigneeId !== undefined ? { assigneeId: query.assigneeId } : {}),
        ...(query.createdById !== undefined ? { createdById: query.createdById } : {}),
        ...(query.teamId !== undefined ? { teamId: query.teamId } : {}),
        ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: PAGE_LIMIT,
      },
    });

  const listAllTasks: CalendarApi["listAllTasks"] = async (query = {}) => {
    const all: task.Task[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await listTasks({ ...query, ...(cursor ? { cursor } : {}) });
      all.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  };

  const listMyTasks: CalendarApi["listMyTasks"] = async (currentUserId) => {
    // Two self-scoped lenses, run in parallel then merged (last write wins on id),
    // identical to マイタスク's lensQueries("all"). Both satisfy the "/me rule".
    const [assigned, created] = await Promise.all([
      listAllTasks({ assigneeId: currentUserId }),
      listAllTasks({ createdById: currentUserId }),
    ]);
    const byId = new Map<common.TaskId, task.Task>();
    for (const t of assigned) byId.set(t.id, t);
    for (const t of created) byId.set(t.id, t);
    return [...byId.values()];
  };

  const createTask: CalendarApi["createTask"] = (req) =>
    api.request<task.Task>({ method: "POST", path: `${P}/tasks`, body: req });

  const updateTask: CalendarApi["updateTask"] = (id, req) =>
    api.request<task.Task>({ method: "PATCH", path: `${P}/tasks/${encodeURIComponent(id)}`, body: req });

  const deleteTask: CalendarApi["deleteTask"] = async (id) => {
    await api.request<unknown>({ method: "DELETE", path: `${P}/tasks/${encodeURIComponent(id)}` });
  };

  const listRoles: CalendarApi["listRoles"] = async () => {
    const all: identity.Role[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.request<common.Paginated<identity.Role>>({
        method: "GET",
        path: `${P}/identity/roles`,
        query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      all.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  };

  const getUsers: CalendarApi["getUsers"] = async (ids) => {
    const page = await api.request<common.Paginated<identity.UserSummary>>({
      method: "GET",
      path: `${P}/identity/users`,
      query: { ids: ids.join(","), limit: PAGE_LIMIT },
    });
    return page.items;
  };

  const m = (id: string): `/api/v1/${string}` => `${P}/meetings/${encodeURIComponent(id)}`;
  return {
    listTasks,
    listAllTasks,
    listMyTasks,
    createTask,
    updateTask,
    deleteTask,
    listRoles,
    getUsers,
    listMeetings: () => api.request<meeting.ListMeetingsResponse>({ method: "GET", path: `${P}/meetings` }),
    listMeetingTargets: () => api.request<meeting.ListMeetingTargetsResponse>({ method: "GET", path: `${P}/meetings/targets` }),
    createMeeting: (body) => api.request<meeting.Meeting>({ method: "POST", path: `${P}/meetings`, body }),
    updateMeeting: (id, body) => api.request<meeting.Meeting>({ method: "PATCH", path: m(id), body }),
    deleteMeeting: async (id) => {
      await api.request<unknown>({ method: "DELETE", path: m(id) });
    },
    syncMeetings: () => api.request<meeting.SyncMeetingsResponse>({ method: "POST", path: `${P}/meetings/sync` }),
  };
}
