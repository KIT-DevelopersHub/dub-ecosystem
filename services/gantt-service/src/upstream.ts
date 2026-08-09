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

interface DependenciesResponse {
  dependencies: task.TaskDependency[];
}

export function createHttpUpstream(env: Env): UpstreamPort {
  const taskSvc: ServiceClient = createServiceClient(env.SVC_TASK, { service: "task-service", caller: SERVICE_NAME });
  const eventSvc: ServiceClient = createServiceClient(env.SVC_EVENT, { service: "event-service", caller: SERVICE_NAME });

  return {
    async listTasks(ctx: RequestContext, eventId: common.EventId): Promise<task.Task[]> {
      const out: task.Task[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await taskSvc.get<task.ListTasksResponse>(ctx, "/tasks", {
          query: { eventId, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        for (const t of res.items) if (t.archivedAt === null) out.push(t);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      return out;
    },

    async listDependencies(ctx: RequestContext, eventId: common.EventId): Promise<task.TaskDependency[]> {
      const res = await taskSvc.get<DependenciesResponse | task.TaskDependency[]>(ctx, "/tasks/dependencies", {
        query: { eventId },
      });
      return Array.isArray(res) ? res : res.dependencies;
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
  };
}
