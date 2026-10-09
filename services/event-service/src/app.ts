// Hono app — a thin HTTP adapter over EventService. Routing table matches the
// gateway mount (/events/* and /actions/* both target this Worker; the gateway
// strips only API_PREFIX).
//
// AUTHZ: no key check in this file. `policyGate` is mounted FIRST and derives both authn (the
// trusted x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which lists
// every route below; a route absent from the table is denied (403). Handlers therefore assume
// an authorized caller and read it with `c.get("userId")`. Do NOT add a permission check to a
// route or a handler — add the route to the table (test/policy-table.test.ts fails if you
// forget). The ONE exception is deliberate and documented: the body-dependent, event-SCOPED
// `event:admin` demand on a backward phase transition, which lives in EventService.updateEvent
// because a static table cannot see the request body (policy-gate gate.ts, b-5 layer 2).
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import { policyGate, type PolicyGateVars } from "@dub/policy-gate";
import type { event } from "@dub/types";
import type {
  AppDeps,
  CreateActionRequest,
  UpdateActionRequest,
  SaveEventDetailsRequest,
  SaveEventSectionLayoutRequest,
  SaveEventPageLayoutRequest,
} from "./types";
import { POLICY_TABLE } from "./policy-table";
import { EventService, type ReqCtx } from "./service";

type Vars = PolicyGateVars & { dubCtx: RequestContext };

// Every route that reaches a handler needing this has a RequiredKeys rule, so the gate has
// already proven a session and published the id — `userId` is a fact here, not a maybe (hence
// the `as string | undefined`: PolicyGateVars types it non-optional because of that, while a
// route re-ruled to bare INTERNAL would leave it unset). The fallbacks keep that honest.
function reqCtx(c: Context<{ Variables: Vars }>): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = (c.get("userId") as string | undefined) ?? ctx?.userId ?? c.req.header("x-dub-user-id");
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

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const svc = new EventService(deps);
  const app = new Hono<{ Variables: Vars }>();

  app.onError(dubErrorHandler({ service: "event-service" }));

  // The authorization layer. First, so it runs before every route below (including any route
  // added later) and before the context parser — nothing in this app is reachable unlisted.
  app.use("*", policyGate({ service: "event-service", table: POLICY_TABLE, granted: deps.authz }));
  app.use("*", dubContext({ allowGenerate: true }));

  // INTERNAL in the table: reachable only over a Service Binding carrying x-dub-internal,
  // which is exactly how app-health-monitor probes it.
  app.get("/health", (c) => c.json({ status: "ok", service: "event-service" }));

  // ---- events ----
  app.get("/events", async (c) => {
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

  app.post("/events", async (c) => {
    const body = await readJson<event.CreateEventRequest>(c);
    const created = await svc.createEvent(reqCtx(c), body);
    return c.json(created, 201);
  });

  app.get("/events/:id", async (c) => {
    return c.json(await svc.getEvent(reqCtx(c), c.req.param("id")));
  });

  app.patch("/events/:id", async (c) => {
    const body = await readJson<event.UpdateEventRequest>(c);
    return c.json(await svc.updateEvent(reqCtx(c), c.req.param("id"), body));
  });

  app.delete("/events/:id", async (c) => {
    await svc.archiveEvent(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/events/:id/participants", async (c) => {
    return c.json(await svc.listParticipants(reqCtx(c), c.req.param("id")));
  });

  // ---- event details (free-form per-event store) ----
  app.get("/events/:id/details", async (c) => {
    return c.json(await svc.getEventDetails(reqCtx(c), c.req.param("id")));
  });

  app.put("/events/:id/details", async (c) => {
    const body = await readJson<SaveEventDetailsRequest>(c);
    return c.json(await svc.saveEventDetails(reqCtx(c), c.req.param("id"), body));
  });

  // ---- event section layout (shared D&D order/visibility of the detail sections) ----
  app.get("/events/:id/section-layout", async (c) => {
    return c.json(await svc.getEventSectionLayout(reqCtx(c), c.req.param("id")));
  });

  app.put("/events/:id/section-layout", async (c) => {
    const body = await readJson<SaveEventSectionLayoutRequest>(c);
    return c.json(await svc.saveEventSectionLayout(reqCtx(c), c.req.param("id"), body));
  });

  // ---- event page layout (free block-editor doc for the event hub page) ----
  app.get("/events/:id/page-layout", async (c) => {
    return c.json(await svc.getEventPageLayout(reqCtx(c), c.req.param("id")));
  });

  app.put("/events/:id/page-layout", async (c) => {
    const body = await readJson<SaveEventPageLayoutRequest>(c);
    return c.json(await svc.saveEventPageLayout(reqCtx(c), c.req.param("id"), body));
  });

  // ---- actions (hierarchy: created only under an event) ----
  app.get("/events/:id/actions", async (c) => {
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

  app.post("/events/:id/actions", async (c) => {
    const body = await readJson<CreateActionRequest>(c);
    const created = await svc.createAction(reqCtx(c), c.req.param("id"), body);
    return c.json(created, 201);
  });

  app.get("/actions/:id", async (c) => {
    return c.json(await svc.getAction(reqCtx(c), c.req.param("id")));
  });

  app.patch("/actions/:id", async (c) => {
    const body = await readJson<UpdateActionRequest>(c);
    return c.json(await svc.updateAction(reqCtx(c), c.req.param("id"), body));
  });

  app.delete("/actions/:id", async (c) => {
    await svc.archiveAction(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
