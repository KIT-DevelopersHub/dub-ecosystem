// GET /api/v1/bff/home — SPA home one-shot. Sources are all optional and fetched in
// parallel with a per-call budget; failures degrade to partialErrors (200). Only a
// missing/invalid session (401) is a whole-request error (handled in authenticate).
//
// Aggregated sources (each degrades independently to a partialErrors entry):
//   • event-service        /events           → upcomingEvents
//   • notification-service /inbox/unread-count → unreadCount
//   • task-service         /tasks?assigneeId → taskSummary (caller's own tasks)
//   • usage-meter          /usage/summary    → usageSummary (free-tier snapshot)
//   • member-service       /members/overview → orgStats (運営メンバー / チーム)
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { event, notification, gateway, task, member } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { isDubError } from "@dub/errors";
import { createServices } from "../services";
import { authenticate } from "../auth";
import { getRequestId } from "../context";

const PER_CALL_TIMEOUT_MS = 3000;
const UPCOMING_LIMIT = 5;
// Caller's-own task pull for the dashboard breakdown. One page is plenty for the
// completion gauge; we page defensively up to a small cap so a very active operator
// is still counted without unbounded round-trips inside the per-call budget.
const TASK_PAGE_LIMIT = 200;
const TASK_MAX_PAGES = 5;
// The usage metrics surfaced on the home dashboard, in display order. Keeping the
// allow-list here (not the whole /usage/summary catalog) keeps the home projection
// bounded to the free-tier lines that matter at a glance.
const HOME_USAGE_METRIC_KEYS: readonly string[] = [
  "kv_reads_day",
  "d1_rows_read_day",
  "workers_requests_day",
  "emails_month",
];

// Parse-only shape of usage-meter's /usage/summary (its contract is not in
// @dub/types). We read only the three fields the home projection needs.
interface UsageSummaryWire {
  services?: Array<{ metricKey?: string; label?: string; pct?: number | null }>;
}

function errCode(err: unknown): string {
  return isDubError(err) ? err.code : "INTERNAL";
}

function emptyTaskCounts(): Record<task.TaskStatus, number> {
  return { todo: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 };
}

/** Page the caller's own tasks (bounded) and bucket them by status. */
async function fetchTaskSummary(
  svc: ReturnType<typeof createServices>,
  ctx: RequestContext,
): Promise<gateway.HomeTaskSummary> {
  const byStatus = emptyTaskCounts();
  let total = 0;
  let cursor: string | null = null;
  for (let page = 0; page < TASK_MAX_PAGES; page++) {
    const query: Record<string, string> = {
      assigneeId: ctx.userId ?? "",
      limit: String(TASK_PAGE_LIMIT),
    };
    if (cursor) query.cursor = cursor;
    const res: task.ListTasksResponse = await svc.task.get<task.ListTasksResponse>(ctx, "/tasks", {
      query,
      timeoutMs: PER_CALL_TIMEOUT_MS,
    });
    for (const t of res.items ?? []) {
      if (t.status in byStatus) byStatus[t.status] += 1;
      total += 1;
    }
    cursor = res.nextCursor ?? null;
    if (!cursor) break;
  }
  return { total, byStatus };
}

/** Project usage-meter's summary to the bounded free-tier snapshot the home shows. */
function projectUsage(wire: UsageSummaryWire): gateway.HomeUsageSummary {
  const all = wire.services ?? [];
  const metrics: gateway.HomeUsageMetric[] = all
    .filter((s): s is { metricKey: string; label?: string; pct?: number | null } => typeof s.metricKey === "string")
    .filter((s) => HOME_USAGE_METRIC_KEYS.includes(s.metricKey))
    .map((s) => ({ key: s.metricKey, label: s.label ?? s.metricKey, pct: s.pct ?? null }));
  const worst = metrics.reduce<gateway.HomeUsageMetric | null>((w, m) => {
    if (m.pct === null) return w;
    if (w === null || w.pct === null || m.pct > w.pct) return m;
    return w;
  }, null);
  return { metrics, worst };
}

export async function bffHomeHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };

  const [eventsRes, unreadRes, tasksRes, usageRes, membersRes] = await Promise.allSettled([
    svc.event.get<event.ListEventsResponse>(ctx, "/events", {
      query: { sort: "startsAt", limit: UPCOMING_LIMIT },
      timeoutMs: PER_CALL_TIMEOUT_MS,
    }),
    svc.notification.get<notification.UnreadCountResponse>(ctx, "/inbox/unread-count", {
      timeoutMs: PER_CALL_TIMEOUT_MS,
    }),
    fetchTaskSummary(svc, ctx),
    svc.usage.get<UsageSummaryWire>(ctx, "/usage/summary", { timeoutMs: PER_CALL_TIMEOUT_MS }),
    svc.member.get<member.MembersOverview>(ctx, "/members/overview", { timeoutMs: PER_CALL_TIMEOUT_MS }),
  ]);

  const partialErrors: gateway.UpstreamPartialError[] = [];

  let upcomingEvents: event.EventSummary[] = [];
  if (eventsRes.status === "fulfilled") {
    upcomingEvents = eventsRes.value.items;
  } else {
    partialErrors.push({ source: "event-service", code: errCode(eventsRes.reason) });
  }

  let unreadCount = 0;
  if (unreadRes.status === "fulfilled") {
    unreadCount = unreadRes.value.count;
  } else {
    partialErrors.push({ source: "notification-service", code: errCode(unreadRes.reason) });
  }

  let taskSummary: gateway.HomeTaskSummary | undefined;
  if (tasksRes.status === "fulfilled") {
    taskSummary = tasksRes.value;
  } else {
    partialErrors.push({ source: "task-service", code: errCode(tasksRes.reason) });
  }

  let usageSummary: gateway.HomeUsageSummary | undefined;
  if (usageRes.status === "fulfilled") {
    usageSummary = projectUsage(usageRes.value);
  } else {
    partialErrors.push({ source: "usage-meter", code: errCode(usageRes.reason) });
  }

  let orgStats: gateway.HomeOrgStats | undefined;
  if (membersRes.status === "fulfilled") {
    orgStats = {
      members: membersRes.value.members?.length ?? 0,
      teams: membersRes.value.teams?.length ?? 0,
    };
  } else {
    partialErrors.push({ source: "member-service", code: errCode(membersRes.reason) });
  }

  const body: gateway.BffHomeResponse = {
    upcomingEvents,
    unreadCount,
    ...(taskSummary ? { taskSummary } : {}),
    ...(usageSummary ? { usageSummary } : {}),
    ...(orgStats ? { orgStats } : {}),
    partialErrors,
  };
  return c.json(body);
}
