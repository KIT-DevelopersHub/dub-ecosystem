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
/** Bounded retries for the date read-modify-write when the task version races (症状#8). A
 *  couple of re-reads absorb overlapping bar-resize writes; a persistent 409 still surfaces. */
const RMW_MAX_RETRIES = 3;

// task-service GET /tasks/dependencies wire shape (frozen): { items: TaskDependency[] }.
// Edge id/type/lagDays are NOT carried here — gantt composes those in dto.ts.
interface ListDependenciesResponse {
  items: task.TaskDependency[];
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
      //
      // The GET and the PATCH are two separate hops, so the version can move between them.
      // gantt is the ONLY writer on this path and only ever sets the two date columns, so a
      // 409 here is almost always a SPURIOUS self-conflict from concurrent bar writes — two
      // quick/overlapping resizes, or a parent resize that fans out child writes while the
      // user drags again (症状#8「バーリサイズが たまに エラー」). Surfacing it rolled the bar
      // back with "他の人が更新しました" for an edit nobody else touched. Because we re-read the
      // fresh version and re-apply the SAME absolute dates, a bounded retry converges safely
      // (idempotent, last-writer-wins on the date fields only; title/status untouched). Only a
      // persistent conflict past the cap propagates as a real 409.
      const path = `/tasks/${encodeURIComponent(taskId)}`;
      for (let attempt = 0; ; attempt++) {
        const current = await taskSvc.get<task.Task>(ctx, path);
        const patch: task.UpdateTaskRequest = {
          version: current.version,
          startAt: dates.startsAt,
          dueAt: dates.endsAt,
        };
        try {
          return await taskSvc.patch<task.Task>(ctx, path, patch);
        } catch (e) {
          // Retry ONLY on a version conflict (the read-modify-write race), and only while
          // attempts remain. A date-only PATCH can 409 for no other reason, but match the code
          // explicitly so a future non-version 409 is never silently retried. Any other error
          // (404/403/5xx) — or an exhausted retry — throws.
          if (attempt < RMW_MAX_RETRIES && isDubError(e) && e.status === 409 && e.code === "TASK_VERSION_CONFLICT") {
            console.warn(
              JSON.stringify({
                level: "warn",
                service: SERVICE_NAME,
                event: "gantt.rows.version_retry",
                message: "task version moved between read and write; retrying date RMW",
                requestId: ctx.requestId,
                taskId,
                attempt: attempt + 1,
              }),
            );
            continue;
          }
          throw e;
        }
      }
    },
  };
}
