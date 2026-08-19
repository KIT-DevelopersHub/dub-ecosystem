// Real UpstreamPort: task-service + event-service via Service Bindings (@dub/http).
// Read-only. User context (x-dub-user-id) propagates automatically for authz upstream.
import { createServiceClient, type RequestContext, type ServiceClient } from "@dub/http";
import { isDubError } from "@dub/errors";
import type { task, event, common } from "@dub/types";
import type { Env } from "./env";
import { SERVICE_NAME } from "./env";
import type { UpstreamPort } from "./ports";

const PAGE_LIMIT = 200; // common.CursorQuery max
const MAX_PAGES = 25; // safety bound (<= 5000 tasks; calc/gantt upper bound)

// task-service GET /tasks/dependencies wire shape (frozen): { items: TaskDependency[] }.
// Edge id/type/lagDays are NOT carried here — gantt composes those in dto.ts.
interface ListDependenciesResponse {
  items: task.TaskDependency[];
}
// GET /tasks/cross-links wire shape (same envelope as dependencies).
interface ListCrossLinksResponse {
  items: task.TaskCrossLink[];
}

export function createHttpUpstream(env: Env): UpstreamPort {
  const taskSvc: ServiceClient = createServiceClient(env.SVC_TASK, { service: "task-service", caller: SERVICE_NAME });
  const eventSvc: ServiceClient = createServiceClient(env.SVC_EVENT, { service: "event-service", caller: SERVICE_NAME });

  return {
    async listTasks(ctx: RequestContext, eventId: common.EventId): Promise<task.Task[]> {
      const out: task.Task[] = [];
      let cursor: string | undefined;
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await taskSvc.get<task.ListTasksResponse>(ctx, "/tasks", {
          query: { eventId, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        for (const t of res.items) if (t.archivedAt === null) out.push(t);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
        // Still more pages after consuming the last allowed page => hard truncation.
        if (page === MAX_PAGES - 1) truncated = true;
      }
      // Silent truncation past MAX_PAGES drops tasks from the chart with no signal;
      // surface it as a structured warning ([observability] captures console logs)
      // so operators can detect events that have outgrown the read-model bound.
      if (truncated) {
        console.warn(
          JSON.stringify({
            level: "warn",
            service: SERVICE_NAME,
            event: "gantt.tasks.truncated",
            message: "task pagination hit MAX_PAGES; gantt DTO omits tasks beyond the cap",
            requestId: ctx.requestId,
            eventId,
            maxPages: MAX_PAGES,
            pageLimit: PAGE_LIMIT,
            loadedTasks: out.length,
          }),
        );
      }
      return out;
    },

    async listDependencies(ctx: RequestContext, eventId: common.EventId): Promise<task.TaskDependency[]> {
      const res = await taskSvc.get<ListDependenciesResponse>(ctx, "/tasks/dependencies", {
        query: { eventId },
      });
      return res.items;
    },

    async listCrossLinks(ctx: RequestContext, eventId: common.EventId): Promise<task.TaskCrossLink[]> {
      const res = await taskSvc.get<ListCrossLinksResponse>(ctx, "/tasks/cross-links", {
        query: { eventId },
      });
      return res.items;
    },

    async eventExists(ctx: RequestContext, eventId: common.EventId): Promise<boolean> {
      try {
        await eventSvc.get<event.GetEventResponse>(ctx, `/events/${encodeURIComponent(eventId)}`);
        return true;
      } catch (e) {
        if (isDubError(e) && e.status === 404) return false;
        throw e;
      }
    },

    async updateTaskDates(
      ctx: RequestContext,
      taskId: common.TaskId,
      dates: { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
    ): Promise<task.Task> {
      // Read-modify-write: the task carries the optimistic version, so read it first
      // (404 propagates as-is) then PATCH with the fresh version. gantt maps the bar
      // window onto the task's real columns: startsAt → startAt, endsAt → dueAt.
      const current = await taskSvc.get<task.Task>(ctx, `/tasks/${encodeURIComponent(taskId)}`);
      const patch: task.UpdateTaskRequest = {
        version: current.version,
        startAt: dates.startsAt,
        dueAt: dates.endsAt,
      };
      return taskSvc.patch<task.Task>(ctx, `/tasks/${encodeURIComponent(taskId)}`, patch);
    },
  };
}
