// Hono app — a thin HTTP adapter over EventService. Routing table matches the
// gateway mount (/events/* and /actions/* both target this Worker; the gateway
// strips only API_PREFIX).
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import type { event } from "@dub/types";
import type { AppDeps, CreateActionRequest, UpdateActionRequest, SaveEventDetailsRequest } from "./types";
import { EventService, type ReqCtx } from "./service";

function reqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = ctx?.userId ?? c.req.header("x-dub-user-id");
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId, userId };
}

function qBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}
function qNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw errors.validationFailed([{ field: "limit", reason: "invalid" }]);
  return n;
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono {
  const svc = new EventService(deps);
  const app = new Hono();

  app.onError(dubErrorHandler({ service: "event-service" }));
  app.use("*", dubContext({ allowGenerate: true }));

  app.get("/health", (c) => c.json({ status: "ok", service: "event-service" }));

  const { authz } = deps;
  const eventIdScope = (c: Context) => ({ resourceType: "event", resourceId: c.req.param("id") });

  // Auth on everything except /health.
  app.use("/events/*", authz.requireAuth());
  app.use("/events", authz.requireAuth());
  app.use("/actions/*", authz.requireAuth());

  // ---- events ----
  app.get("/events", authz.requirePermission("event:read"), async (c) => {
    const q = c.req.query();
    const query: event.ListEventsQuery = {
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
      ...(q.phase ? { phase: q.phase as event.EventPhase } : {}),
      ...(q.startsAfter ? { startsAfter: q.startsAfter } : {}),
      ...(q.sort === "startsAt" ? { sort: "startsAt" as const } : {}),
      ...(qBool(q.includeArchived) !== undefined ? { includeArchived: qBool(q.includeArchived) } : {}),
    };
    return c.json(await svc.listEvents(reqCtx(c), query));
  });

  app.post("/events", authz.requirePermission("event:write"), async (c) => {
    const body = await readJson<event.CreateEventRequest>(c);
    const created = await svc.createEvent(reqCtx(c), body);
    return c.json(created, 201);
  });

  app.get("/events/:id", authz.requirePermission("event:read", eventIdScope), async (c) => {
    return c.json(await svc.getEvent(reqCtx(c), c.req.param("id")));
  });

  app.patch("/events/:id", authz.requirePermission("event:write", eventIdScope), async (c) => {
    const body = await readJson<event.UpdateEventRequest>(c);
    return c.json(await svc.updateEvent(reqCtx(c), c.req.param("id"), body));
  });

  app.delete("/events/:id", authz.requirePermission("event:admin", eventIdScope), async (c) => {
    await svc.archiveEvent(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/events/:id/participants", authz.requirePermission("event:read", eventIdScope), async (c) => {
    return c.json(await svc.listParticipants(reqCtx(c), c.req.param("id")));
  });

  // ---- event details (free-form per-event store) ----
  app.get("/events/:id/details", authz.requirePermission("event:read", eventIdScope), async (c) => {
    return c.json(await svc.getEventDetails(reqCtx(c), c.req.param("id")));
  });

  app.put("/events/:id/details", authz.requirePermission("event:write", eventIdScope), async (c) => {
    const body = await readJson<SaveEventDetailsRequest>(c);
    return c.json(await svc.saveEventDetails(reqCtx(c), c.req.param("id"), body));
  });

  // ---- actions (hierarchy: created only under an event) ----
  app.get("/events/:id/actions", authz.requirePermission("event:read", eventIdScope), async (c) => {
    const q = c.req.query();
    return c.json(
      await svc.listActions(reqCtx(c), c.req.param("id"), {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(qBool(q.includeArchived) !== undefined ? { includeArchived: qBool(q.includeArchived) } : {}),
      }),
    );
  });

  app.post("/events/:id/actions", authz.requirePermission("event:write", eventIdScope), async (c) => {
    const body = await readJson<CreateActionRequest>(c);
    const created = await svc.createAction(reqCtx(c), c.req.param("id"), body);
    return c.json(created, 201);
  });

  app.get("/actions/:id", authz.requirePermission("event:read"), async (c) => {
    return c.json(await svc.getAction(reqCtx(c), c.req.param("id")));
  });

  app.patch("/actions/:id", authz.requirePermission("event:write"), async (c) => {
    const body = await readJson<UpdateActionRequest>(c);
    return c.json(await svc.updateAction(reqCtx(c), c.req.param("id"), body));
  });

  app.delete("/actions/:id", authz.requirePermission("event:write"), async (c) => {
    await svc.archiveAction(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
