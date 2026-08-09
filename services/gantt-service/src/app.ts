// Hono app. Routes mount under /api/v1/gantt at the gateway; paths here are the
// internal (stripPrefix) paths. Deps are injected (ports.ts) for testability.
import { Hono, type MiddlewareHandler } from "hono";
import { dubErrorHandler, DubError, CommonErrorCodes } from "@dub/errors";
import { dubContext, type RequestContext } from "@dub/http";
import type { AuthnContext, AuthClient } from "@dub/auth-client";
import type { gantt, common } from "@dub/types";
import type { Env } from "./env";
import { SERVICE_NAME } from "./env";
import type { AppDeps } from "./ports";
import { buildGanttChartDTO } from "./dto";
import { validatePutBody } from "./views";
import { defaultDeps } from "./deps";

type Vars = { dubCtx: RequestContext; authn: AuthnContext };
type App = Hono<{ Bindings: Env; Variables: Vars }>;

export const GANTT_EVENT_NOT_FOUND = "GANTT_EVENT_NOT_FOUND";

function requireEventId(c: { req: { query: (k: string) => string | undefined } }): common.EventId {
  const eventId = c.req.query("eventId");
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
    const eventId = c.req.query("eventId");
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
