// Task-service read client used for participant synthesis (GET /events/:id/participants).
// The contract (§3.6) says participants include the assignees of ALL of the event's
// tasks — so we must page through the full result set, not just the first page.
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import type { common, task } from "@dub/types";
import type { TaskClient } from "./types";

// Per-page fetch size (task-service caps list `limit` at its own MAX_LIMIT).
export const TASK_PAGE_LIMIT = 200;
// Safety valve against a misbehaving upstream that never returns nextCursor=null.
// TASK_PAGE_LIMIT * MAX_TASK_PAGES bounds the walk well above any realistic event.
export const MAX_TASK_PAGES = 200;

/**
 * Walk every page of an event's tasks and collect the distinct, non-null
 * assignee user ids. `fetchPage(cursor)` returns one page; the loop follows
 * `nextCursor` until it is null (or the page-count safety cap is hit).
 */
export async function collectAssigneeIds(
  fetchPage: (cursor?: string) => Promise<task.ListTasksResponse>,
): Promise<common.UserId[]> {
  const ids = new Set<common.UserId>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TASK_PAGES; page++) {
    const res = await fetchPage(cursor);
    for (const t of res.items) if (t.assigneeId) ids.add(t.assigneeId);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return [...ids];
}

export function buildTaskClient(taskBinding: Fetcher | undefined): TaskClient {
  return {
    async listAssigneeIds(ctx, eventId) {
      if (!taskBinding) return []; // SVC_TASK optional in local/preview
      const client = createServiceClient(taskBinding, { service: "task-service", caller: "event-service" });
      const rc: RequestContext = { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
      return collectAssigneeIds((cursor) =>
        client.get<task.ListTasksResponse>(rc, "/tasks", {
          query: { eventId, limit: TASK_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        }),
      );
    },
  };
}
