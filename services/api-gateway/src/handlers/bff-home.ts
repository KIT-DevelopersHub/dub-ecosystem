// GET /api/v1/bff/home — SPA home one-shot. Sources are all optional and fetched in
// parallel with a per-call budget; failures degrade to partialErrors (200). Only a
// missing/invalid session (401) is a whole-request error (handled in authenticate).
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { event, notification, gateway } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { isDubError } from "@dub/errors";
import { createServices } from "../services";
import { authenticate } from "../auth";
import { getRequestId } from "../context";

const PER_CALL_TIMEOUT_MS = 3000;
const UPCOMING_LIMIT = 5;

function errCode(err: unknown): string {
  return isDubError(err) ? err.code : "INTERNAL";
}

export async function bffHomeHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);

  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };

  const [eventsRes, unreadRes] = await Promise.allSettled([
    svc.event.get<event.ListEventsResponse>(ctx, "/events", {
      query: { sort: "startsAt", limit: UPCOMING_LIMIT },
      timeoutMs: PER_CALL_TIMEOUT_MS,
    }),
    svc.notification.get<notification.UnreadCountResponse>(ctx, "/inbox/unread-count", {
      timeoutMs: PER_CALL_TIMEOUT_MS,
    }),
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

  const body: gateway.BffHomeResponse = { upcomingEvents, unreadCount, partialErrors };
  return c.json(body);
}
