// BFF aggregation. Composes mobile-shaped payloads from the master services; the
// summary DTOs are owned by event/task (design §1 — MO3 re-defines nothing). The
// home aggregate tolerates partial upstream failure (empty/zero defaults); the
// event overview treats its single event source as required.
import type { ServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import type { event, task, notification, mobile, identity } from "@dub/types";

export interface UpstreamPartialError {
  source: string;
  code: string;
}

export interface HomeAggregateDeps {
  event: ServiceClient;
  task: ServiceClient;
  notification: ServiceClient;
}

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return "UPSTREAM_UNAVAILABLE";
}

function toTaskSummary(t: task.Task): task.TaskSummary {
  return { id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId };
}

function toEventSummary(e: event.EventSummary | event.EventDetail): event.EventSummary {
  return { id: e.id, title: e.title, phase: e.phase, startsAt: e.startsAt };
}

/** GET /m/v1/bff/home — event + task + unread, partial-failure tolerant. */
export async function buildHome(
  deps: HomeAggregateDeps,
  ctx: RequestContext,
  userId: string,
): Promise<{ home: mobile.MobileHomeResponse; partialErrors: UpstreamPartialError[] }> {
  const partialErrors: UpstreamPartialError[] = [];

  const eventsP = deps.event
    .get<event.ListEventsResponse>(ctx, "/events", { query: { sort: "startsAt", limit: 20 } })
    .then((r) => r.items)
    .catch((err) => {
      partialErrors.push({ source: "event-service", code: errCode(err) });
      return [] as event.EventSummary[];
    });

  const tasksP = deps.task
    .get<task.ListTasksResponse>(ctx, "/tasks", { query: { assigneeId: userId, limit: 20 } })
    .then((r) => r.items.map(toTaskSummary))
    .catch((err) => {
      partialErrors.push({ source: "task-service", code: errCode(err) });
      return [] as task.TaskSummary[];
    });

  const unreadP = deps.notification
    .get<notification.UnreadCountResponse>(ctx, "/inbox/unread-count")
    .then((r) => r.count)
    .catch((err) => {
      partialErrors.push({ source: "notification-service", code: errCode(err) });
      return 0;
    });

  const [upcomingEvents, myTasks, unreadCount] = await Promise.all([eventsP, tasksP, unreadP]);
  return { home: { upcomingEvents, myTasks, unreadCount }, partialErrors };
}

export interface EventOverviewDeps {
  event: ServiceClient;
  capabilities: (ctx: RequestContext, eventId: string) => Promise<identity.PermissionKey[]>;
}

/** GET /m/v1/bff/events/:eventId — event summary + resource-scoped capabilities. */
export async function buildEventOverview(
  deps: EventOverviewDeps,
  ctx: RequestContext,
  eventId: string,
): Promise<mobile.MobileEventOverviewResponse> {
  const [detail, capabilities] = await Promise.all([
    deps.event.get<event.GetEventResponse>(ctx, `/events/${eventId}`), // required source: errors propagate
    deps.capabilities(ctx, eventId),
  ]);
  return { event: toEventSummary(detail), capabilities };
}
