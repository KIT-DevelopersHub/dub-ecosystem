// Hono app. Routes mount under /api/v1/gantt at the gateway; paths here are the
// internal (stripPrefix) paths. Deps are injected (ports.ts) for testability.
//
// AUTHZ — two layers, and both live in known places:
//
//  1. ENTRY LAYER (type-level): `policyGate` is mounted FIRST and derives both authn (the
//     trusted x-dub-user-id header) and the "does this caller hold the key at all" decision
//     from POLICY_TABLE (src/policy-table.ts), which lists every route below. The old
//     `guard()` (requireAuth + requirePermission) and the hand-rolled `/internal/*` marker
//     middleware are both gone. Do NOT add a permission check to a route — add the route to
//     the table (test/policy-table.test.ts fails if you forget).
//
//  2. INSTANCE LAYER (`assertEventScope` below): does the caller's `event:read` apply to THIS
//     event? The gate's `PermissionGranter` port takes no resource and will not grow one
//     (gate.ts), so the event-scoped half of the old guard lives here, in the handler that
//     has the event id. Every route that was event-scoped before this migration still is —
//     dropping that would widen the API from "the events you may read" to the whole org
//     (inventory b-5), and the write path gains the scope check it never had (a-4).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { dubErrorHandler, DubError, CommonErrorCodes, errors } from "@dub/errors";
import { dubContext, type RequestContext } from "@dub/http";
import { HEADERS } from "@dub/observability";
import type { AuthClient } from "@dub/auth-client";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { DubEventEnvelope } from "@dub/events";
import { common as commonTypes, type gantt, type common } from "@dub/types";
import type { Env } from "./env";
import { SERVICE_NAME } from "./env";
import type { AppDeps } from "./ports";
import { POLICY_TABLE } from "./policy-table";
import { buildGanttChartDTO } from "./dto";
import { validatePutBody } from "./views";
import { dispatchEvent } from "./queue";
import { defaultDeps } from "./deps";
import { signWsTicket, ticketExpiryMs, buildDoUrl } from "./wsticket";

// Dev-only fallback secret; production sets WS_TICKET_SECRET via `wrangler secret put`.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";
// Default DO-direct base (gateway-bypassing). ":id" -> eventId. Overridden per env.
const DEFAULT_DO_URL_BASE = "wss://dub-gantt-service.developershub-site.workers.dev/ws/:id";

type Vars = PolicyGateVars & { dubCtx: RequestContext };
type AppBindings = { Bindings: Env; Variables: Vars };
type App = Hono<AppBindings>;

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

/**
 * The gate's `PermissionGranter`, built on the SAME memoized `AuthClient` the instance layer
 * uses — so the two layers share one identity client and one TTL decision cache instead of
 * opening a second. One batched `/authz/check` per rule, however many keys it names.
 * Fail-closed: a transport failure throws and surfaces as 5xx, never as a quiet allow.
 */
function granterFrom(client: AuthClient, requestId: string | undefined): PermissionGranter {
  return async (userId, orgId, keys) => {
    if (keys.length === 0) return [];
    const res = await client.checkPermissions(
      { subjectUserId: userId, orgId, checks: keys.map((permission) => ({ permission })) },
      requestId ? { requestId } : {},
    );
    return keys.filter((_, i) => res.decisions[i]?.allowed === true);
  };
}

/**
 * THE authorization layer, as a thin per-request wrapper around the real `policyGate`.
 *
 * WHY a wrapper and not a one-line mount: `createApp()` is called once per isolate
 * (src/index.ts), so there is no `env` — and therefore no SVC_IDENTITY binding — at mount
 * time. The wrapper builds the granter from `c.env` and delegates; no decision logic is
 * re-implemented here. Same shape as api-gateway's src/policy.ts and usage-meter's app.ts,
 * which have the identical constraint.
 */
function ganttPolicyGate(deps: AppDeps): MiddlewareHandler<AppBindings> {
  return (c, next) => {
    const granted = granterFrom(deps.authClient(c.env), c.req.header(HEADERS.requestId));
    const gate = policyGate({ service: SERVICE_NAME, table: POLICY_TABLE, granted });
    // The gate declares only `Variables` (it knows nothing about a service's Bindings), so
    // the two handler types are structurally compatible in one direction only. Cast once,
    // here, instead of letting it spread through the app's types.
    return (gate as unknown as MiddlewareHandler<AppBindings>)(c, next);
  };
}

/**
 * INSTANCE-LAYER authorization: may this caller read THIS event?
 *
 * The policy table already established that the caller holds `event:read` at all; this asks
 * identity the resource-scoped question the table cannot express (`resourceType`/`resourceId`
 * are request data — gate.ts explains why the port will never take them). It is the exact
 * query the removed `guard()` made, moved to where the event id is known, and it runs on
 * every event-scoped route including the write path, which never had it (inventory a-4).
 *
 * The 403 is deliberately identical to the one `requirePermission` raised — same code, same
 * message — so no client sees a contract change.
 */
async function assertEventScope(
  c: Context<AppBindings>,
  deps: AppDeps,
  eventId: common.EventId,
): Promise<void> {
  const allowed = await deps.authClient(c.env).hasPermission(
    c.get("userId"),
    commonTypes.DUB_DEFAULT_ORG_ID,
    { permission: "event:read", resourceType: "event", resourceId: eventId },
    { ...(c.req.header(HEADERS.requestId) ? { requestId: c.req.header(HEADERS.requestId)! } : {}) },
  );
  if (!allowed) {
    throw new DubError(CommonErrorCodes.FORBIDDEN, "permission denied: event:read", { status: 403 });
  }
}

export function createApp(deps: AppDeps = defaultDeps): App {
  const app = new Hono<AppBindings>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE,
  // including GET /health (PUBLIC by decision) and the INTERNAL landing route (which is why
  // the hand-rolled `/internal/*` marker middleware is gone: the marker check IS the INTERNAL
  // rule now, so the route is visible in the table rather than invisible to a reader of it).
  app.use("*", ganttPolicyGate(deps));

  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

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
    // Realtime hint: a structural change (create/delete/status/assignee/dependency/archive)
    // landed, so the DERIVED chart may have shifted (CPM re-schedule). Tell every viewer of
    // this event's gantt to refetch fresh once (they debounce). Delta-only: we ship just the
    // trigger name, never the chart. eventId is optional on task.* (an unlinked task belongs
    // to no event-scoped gantt) → nothing to fan out. Best-effort (publisher swallows).
    const invalidatedEventId = (body.payload as { eventId?: common.EventId } | undefined)?.eventId;
    if (invalidatedEventId) {
      await deps.realtime(c.env).publishInvalidated(invalidatedEventId, body.name);
    }
    return c.json({ ok: true }, 202);
  });

  // Observability context for the business routes, deliberately AFTER the gate: it performs
  // no authorization, and keeping the gate in first position is the invariant worth
  // protecting. Authn/authz are the gate's job now — there is no `guard()` left to mount.
  //
  // It is NOT mounted on "*": `dubContext` 400s on a missing x-dub-request-id, which GET
  // /health (uptime probe) and the freeq drain landing route legitimately omit.
  //
  // The sub-path mount covers every /gantt/* route; the bare /gantt collection route takes it
  // as a PER-ROUTE middleware instead of an `app.use("/gantt", ...)` mount. That is not a
  // style choice: Hono records an exact-path `use` as a route with method ALL, and
  // `protectableRouteKeys` can only recognise a mount by its wildcard ("*" or "…/*"), so
  // `app.use("/gantt", ...)` registers an `ALL /gantt` that the coverage test reads as an
  // ungated ENDPOINT. Passing the middleware to `app.get` keeps the registration a plain
  // `GET /gantt` (deduped) and the behaviour identical.
  const ganttCtx = dubContext();
  app.use("/gantt/*", ganttCtx);

  // full chart DTO
  app.get("/gantt", ganttCtx, async (c) => {
    const ctx = c.get("dubCtx");
    const eventId = requireEventId(c);
    await assertEventScope(c, deps, eventId);
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
    await assertEventScope(c, deps, eventId);
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
    await assertEventScope(c, deps, eventId);
    const state = await deps.views(c.env).get(c.get("userId"), eventId);
    return c.json(state satisfies gantt.GanttViewState);
  });

  app.put("/gantt/views", async (c) => {
    const eventId = requireEventId(c);
    await assertEventScope(c, deps, eventId);
    const body = await c.req.json().catch(() => ({}));
    const req = validatePutBody(body);
    const state = await deps.views(c.env).put(c.get("userId"), eventId, req);
    return c.json(state satisfies gantt.GanttViewState);
  });

  // ---- GET /gantt/ws-ticket (realtime connect; DO-direct) ----
  // Subscribe follows read access: the table gives this route the same rule as GET /gantt and
  // `assertEventScope` ties it to THIS event, so only a caller who may read the chart gets a
  // ticket. The GanttRoom DO then independently verifies the HMAC ticket + Origin at connect
  // time, but performs NO permission check of its own — issuance is the only authorization
  // the socket ever gets (inventory §3(e) e-5), so neither half may be relaxed. The ticket is
  // short-lived (60s) — just long enough to open the WS after this GET.
  app.get("/gantt/ws-ticket", async (c) => {
    const eventId = requireEventId(c);
    await assertEventScope(c, deps, eventId);
    const userId = c.get("userId");
    const secret = c.env.WS_TICKET_SECRET ?? DEV_WS_SECRET;
    const base = c.env.GANTT_RT_DO_URL_BASE ?? DEFAULT_DO_URL_BASE;
    const expEpochMs = ticketExpiryMs(Date.now());
    const ticket = await signWsTicket(secret, { eventId, userId, expEpochMs });
    const res: gantt.GanttWsTicketResponse = {
      ticket,
      doUrl: buildDoUrl(base, eventId),
      expiresAt: new Date(expEpochMs).toISOString(),
      // Echo the caller's identity so the presence bar can mark "（あなた）" without a
      // second /me round-trip. displayName is resolved client-side from the roster.
      self: { userId },
    };
    return c.json(res satisfies gantt.GanttWsTicketResponse);
  });

  // ---- PATCH /gantt/rows/:taskId (persist a bar's window: startsAt/endsAt) ----
  // The write path a timeline drag/resize OR a start/due edit uses. gantt maps the window
  // onto the underlying task (startsAt→startAt, endsAt→dueAt) via task-service
  // (read-modify-write, optimistic-locked; task-service enforces its own table too). On
  // success the event's cached DTO is purged so the next read reflects the move immediately.
  //
  // AUTHZ (inventory a-4, closed here): the table demands ガント 編集 + `task:write`, and the
  // EVENT SCOPE — which the old `guard()` deliberately skipped on this route, since the
  // request names a task and not an event — is asserted against the task's own event inside
  // `updateTaskDates`, where the row has just been read and BEFORE the patch. So a caller who
  // holds `task:write` but cannot read the task's event now gets a 403 with nothing mutated
  // and nothing fanned out over realtime, instead of silently re-scheduling it.
  app.patch("/gantt/rows/:taskId", async (c) => {
    const ctx = c.get("dubCtx");
    const taskId = c.req.param("taskId");
    const body = validatePatchRowBody(await c.req.json().catch(() => ({})));
    const upstream = deps.upstream(c.env);
    const updated = await upstream.updateTaskDates(ctx, taskId, body, async (current) => {
      // An unlinked task (eventId === null) belongs to no event-scoped gantt, so there is no
      // event to scope to: the table's ガント 編集 + task:write is the whole rule for it.
      if (current.eventId) await assertEventScope(c, deps, current.eventId);
    });
    if (updated.eventId) {
      await deps.cache(c.env).purge(updated.eventId);
      // Realtime delta: fan the moved window out to every other viewer of this event's
      // gantt so their bar jumps the same tick (no whole-chart re-send). Best-effort —
      // the publisher swallows DO failures so the 2xx write is never lost.
      await deps.realtime(c.env).publishRowMoved(updated.eventId, {
        taskId: updated.id,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
      });
    }
    const row: gantt.GanttRow = {
      taskId: updated.id,
      title: updated.title,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      progressPercent: updated.status === "done" ? 100 : 0,
      assigneeId: updated.assigneeId,
      teamId: updated.teamId ?? null,
    };
    return c.json(row satisfies gantt.GanttRow);
  });

  return app;
}

/** Validate the PATCH /gantt/rows body: startsAt/endsAt each ISO8601 or null. */
export function validatePatchRowBody(body: unknown): gantt.PatchGanttRowRequest {
  const o = (body ?? {}) as Partial<gantt.PatchGanttRowRequest>;
  const isIsoOrNull = (v: unknown): v is common.ISODateTime | null =>
    v === null || (typeof v === "string" && ISO_RE.test(v));
  const fe: { field: string; reason: string }[] = [];
  if (!("startsAt" in o) || !isIsoOrNull(o.startsAt)) fe.push({ field: "startsAt", reason: "invalid_format" });
  if (!("endsAt" in o) || !isIsoOrNull(o.endsAt)) fe.push({ field: "endsAt", reason: "invalid_format" });
  if (fe.length > 0) {
    throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "invalid row schedule", { status: 400, details: fe });
  }
  return { startsAt: o.startsAt ?? null, endsAt: o.endsAt ?? null };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
