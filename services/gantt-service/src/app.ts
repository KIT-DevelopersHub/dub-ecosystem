// Hono app. Routes mount under /api/v1/gantt at the gateway; paths here are the
// internal (stripPrefix) paths. Deps are injected (ports.ts) for testability.
import { Hono, type MiddlewareHandler } from "hono";
import { dubErrorHandler, DubError, CommonErrorCodes, errors } from "@dub/errors";
import { dubContext, type RequestContext } from "@dub/http";
import { HEADERS } from "@dub/observability";
import type { AuthnContext, AuthClient } from "@dub/auth-client";
import type { DubEventEnvelope } from "@dub/events";
import type { gantt, common } from "@dub/types";
import type { Env } from "./env";
import { SERVICE_NAME } from "./env";
import type { AppDeps } from "./ports";
import { buildGanttChartDTO } from "./dto";
import { validatePutBody } from "./views";
import { dispatchEvent } from "./queue";
import { defaultDeps } from "./deps";

type Vars = { dubCtx: RequestContext; authn: AuthnContext };
type App = Hono<{ Bindings: Env; Variables: Vars }>;

export const GANTT_EVENT_NOT_FOUND = "GANTT_EVENT_NOT_FOUND";

/** Read the event id query param. The wire key is `eventId` — the single source of truth
 *  (gantt.GetGanttQuery), enforced by the wire-params contract test. The transitional
 *  `?event=` fallback (added when the client still sent the drifted key) is removed now
 *  that every client sends `?eventId`; the server must read ONLY the SoT key. */
function readEventId(c: { req: { query: (k: string) => string | undefined } }): common.EventId | undefined {
  return c.req.query("eventId");
}

function requireEventId(c: { req: { query: (k: string) => string | undefined } }): common.EventId {
  const eventId = readEventId(c);
  if (!eventId) {
    throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "eventId is required", {
      status: 400,
      details: [{ field: "eventId", reason: "required" }],
    });
  }
  return eventId;
}

/** requireAuth -> requirePermission("event:read", event-scoped) as one middleware. */
function guard(client: AuthClient): MiddlewareHandler {
  const requireAuth = client.requireAuth();
  const requirePerm = client.requirePermission("event:read", (c) => {
    const eventId = readEventId(c);
    return eventId ? { resourceType: "event", resourceId: eventId } : {};
  });
  return async (c, next) => {
    await requireAuth(c, async () => {
      await requirePerm(c, next);
    });
  };
}

export function createApp(deps: AppDeps = defaultDeps): App {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

  // ---- internal-only guard: /internal/* requires the x-dub-internal marker. The gateway
  // strips all x-dub-* headers off external requests (proxy spoof-defense), so only genuine
  // service-to-service calls carry it; external callers get a 404 (route never exposed). ----
  app.use("/internal/*", async (c, next) => {
    if (!c.req.header(HEADERS.internal)) throw errors.notFound("route", c.req.path);
    await next();
  });

  // ---- POST /internal/events-async (free-tier consumer landing route) ----
  // Free-plan replacement for the dub-q-evt-gantt Queue consumer: task-service /
  // event-service forward each due task.*/action.*/event.* envelope from their @dub/freeq
  // outbox drains here. Runs the SAME cache-purge / view-reap handlers as the Queue path
  // (dispatchEvent). Handlers are idempotent, so a redelivery is safe; a non-2xx response
  // tells the caller's drain to keep the row pending and retry, so an event is never lost.
  // gantt is a read model and never calls those services back — no event↔task cycle.
  app.post("/internal/events-async", async (c) => {
    const body = await c.req.json<Partial<DubEventEnvelope>>().catch(() => null);
    if (!body || typeof body.name !== "string" || typeof body.id !== "string") {
      throw errors.validationFailed([{ field: "body", reason: "invalid_envelope" }]);
    }
    await dispatchEvent(c.env, body as DubEventEnvelope, deps);
    return c.json({ ok: true }, 202);
  });

  // all business routes: context parse -> authn -> authz(event:read)
  app.use("/gantt", dubContext());
  app.use("/gantt/*", dubContext());
  app.use("/gantt", (c, next) => guard(deps.authClient(c.env))(c, next));
  app.use("/gantt/*", (c, next) => guard(deps.authClient(c.env))(c, next));

  // full chart DTO
  app.get("/gantt", async (c) => {
    const ctx = c.get("dubCtx");
    const eventId = requireEventId(c);
    const upstream = deps.upstream(c.env);
    const cache = deps.cache(c.env);

    if (!(await upstream.eventExists(ctx, eventId))) {
      throw new DubError(GANTT_EVENT_NOT_FOUND, `event not found: ${eventId}`, { status: 404 });
    }

    const noCache = (c.req.header("cache-control") ?? "").toLowerCase().includes("no-cache");
    if (!noCache) {
      const hit = await cache.get(eventId);
      if (hit) return c.json(hit);
    }

    const [tasks, dependencies] = await Promise.all([
      upstream.listTasks(ctx, eventId),
      upstream.listDependencies(ctx, eventId),
    ]);
    const dto = buildGanttChartDTO(eventId, tasks, dependencies);
    await cache.put(eventId, dto);
    return c.json(dto);
  });

  // dependency lines only (lightweight refetch)
  app.get("/gantt/dependencies", async (c) => {
    const ctx = c.get("dubCtx");
    const eventId = requireEventId(c);
    const upstream = deps.upstream(c.env);
    const [tasks, dependencies] = await Promise.all([
      upstream.listTasks(ctx, eventId),
      upstream.listDependencies(ctx, eventId),
    ]);
    const dto = buildGanttChartDTO(eventId, tasks, dependencies);
    return c.json({ eventId, dependencies: dto.dependencies } satisfies {
      eventId: common.EventId;
      dependencies: gantt.GanttDependencyLine[];
    });
  });

  // per-user view state (own row only; userId from trusted header, never the body)
  app.get("/gantt/views", async (c) => {
    const eventId = requireEventId(c);
    const state = await deps.views(c.env).get(c.get("authn").userId, eventId);
    return c.json(state satisfies gantt.GanttViewState);
  });

  app.put("/gantt/views", async (c) => {
    const eventId = requireEventId(c);
    const body = await c.req.json().catch(() => ({}));
    const req = validatePutBody(body);
    const state = await deps.views(c.env).put(c.get("authn").userId, eventId, req);
    return c.json(state satisfies gantt.GanttViewState);
  });

  return app;
}
