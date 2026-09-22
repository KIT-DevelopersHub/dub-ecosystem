// Calendar feature api adapter. The calendar is a NEW VIEW over the SAME task
// data the マイタスク list (FE4) and the ガントチャート read — it owns no backend
// contract of its own. It rides the ONE shell api-client (src/lib/api-client.tsx:
// session cookie, 401→refresh, requestId, error normalization) and calls the
// canonical task-service endpoint GET /api/v1/tasks, typed against @dub/types
// `task` (the API-contract SoT). No schema is added or changed — additive, read-only.
import type { common, task } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

const P = "/api/v1";
/** Server page size; the calendar pages through to load a whole month's tasks. */
const PAGE_LIMIT = 100;
/** Safety cap so a broken cursor can never loop forever. */
const MAX_PAGES = 20;

export interface CalendarTaskQuery {
  /** Optional event scope (kept null/omitted = all tasks visible to the user). */
  eventId?: common.EventId;
  /** Optional assignee scope (e.g. only-mine). */
  assigneeId?: common.UserId;
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
}

export function createCalendarApi(api: ApiClient): CalendarApi {
  const listTasks: CalendarApi["listTasks"] = (query = {}) =>
    api.request<task.ListTasksResponse>({
      method: "GET",
      path: `${P}/tasks`,
      query: {
        ...(query.eventId !== undefined ? { eventId: query.eventId } : {}),
        ...(query.assigneeId !== undefined ? { assigneeId: query.assigneeId } : {}),
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

  return { listTasks, listAllTasks };
}
