// Hono app — the internal HTTP surface (mounted at /github/* behind api-gateway,
// which prepends /api/v1). Routes are declarative; validation + business errors
// come from GithubSyncService, formatting from @dub/errors dubErrorHandler.
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives both authn (the
// trusted x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which
// lists every route below — including the `/internal/*` ones, whose x-dub-internal marker
// check used to be a hand-rolled middleware here and is now the INTERNAL rule form.
// Handlers therefore assume an authorized caller and read it with `c.get("userId")`. Do NOT
// add a permission check to a route or a handler — add the route to the table
// (test/policy-table.test.ts fails if you forget, and the gate denies it meanwhile).
import { Hono } from "hono";
import type { Context } from "hono";
import { DubError, errors } from "@dub/errors";
import { dubErrorHandler } from "@dub/errors";
import { dubContext, type RequestContext } from "@dub/http";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import { common, type auditLog } from "@dub/types";
import type { DubEventEnvelope, WebhookEventEnvelopeV1 } from "@dub/events";
import type { Env } from "./env";
import type { GithubSyncService } from "./service";
import type { Publisher } from "./events/publisher";
import { POLICY_TABLE } from "./policy-table";
import { dispatchDomainEvent, dispatchWebhook, type QueueDeps } from "./queue";
import type { CreateLinkRequest, RegisterRepoRequest, UpdateRepoRequest } from "./domain/types";

export interface AppDeps {
  service: GithubSyncService;
  publisher: Publisher;
  now: () => string;
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
  // Inbound-event ports (engine + idempotency + R2). Powers the free-tier consumer
  // landing routes; the Queue consumers in index.ts use the same QueueDeps.
  queue: QueueDeps;
}

type Vars = PolicyGateVars & { dubCtx: RequestContext };

function ctxOf(c: Context): RequestContext {
  return c.get("dubCtx") as RequestContext;
}

async function jsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new DubError("GITHUB_VALIDATION_FAILED", "invalid JSON body", { status: 400 });
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();

  app.onError(dubErrorHandler({ service: "github-sync" }));

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE,
  // which is also what makes the `/internal/*` routes internal-only (INTERNAL rule) now that
  // the hand-rolled marker middleware is gone.
  app.use("*", policyGate({ service: "github-sync", table: POLICY_TABLE, granted: deps.authz }));

  // ---- liveness (INTERNAL in the table: reachable only over a Service Binding carrying
  // x-dub-internal, which is exactly how app-health-monitor probes it). ----
  app.get("/internal/health", (c) => c.json({ status: "ok", service: "github-sync" }));

  // ---- POST /internal/events-async (free-tier domain-event consumer landing route) ----
  // Free-plan replacement for the dub-q-evt-github-sync Queue consumer: task-service /
  // event-service forward each due task.*/event.archived envelope from their @dub/freeq
  // outbox drains here. Runs the SAME sync engine + envelope.id idempotency as the Queue
  // path (dispatchDomainEvent). A non-2xx tells the caller's drain to keep the row pending
  // and retry, so an event is never lost. github-sync's github.* fan-out does not target
  // task/event-service, so no cycle is reintroduced.
  app.post("/internal/events-async", async (c) => {
    const body = await c.req.json<Partial<DubEventEnvelope>>().catch(() => null);
    if (!body || typeof body.name !== "string" || typeof body.id !== "string") {
      throw errors.validationFailed([{ field: "body", reason: "invalid_envelope" }]);
    }
    await dispatchDomainEvent(deps.queue, body as DubEventEnvelope);
    return c.json({ ok: true }, 202);
  });

  // ---- POST /internal/webhooks-async (free-tier raw-webhook consumer landing route) ----
  // Free-plan replacement for the dub-q-wh-github Queue consumer: webhook-ingest forwards
  // each due GitHub webhook envelope (WebhookEventEnvelopeV1) from its @dub/freeq outbox
  // drain here. Runs the SAME parse + apply + envelope.id idempotency as the Queue path
  // (dispatchWebhook); a non-2xx keeps the caller's row pending (event never lost).
  app.post("/internal/webhooks-async", async (c) => {
    const body = await c.req.json<Partial<WebhookEventEnvelopeV1>>().catch(() => null);
    if (!body || body.source !== "github" || typeof body.id !== "string") {
      throw errors.validationFailed([{ field: "body", reason: "invalid_envelope" }]);
    }
    await dispatchWebhook(deps.queue, body as WebhookEventEnvelopeV1);
    return c.json({ ok: true }, 202);
  });

  // ---- POST /internal/reconcile/kick (free-plan reconcile-alarm bootstrap) ----
  // Arms the GithubReconcileDO alarm loop once after a free-tier deploy (wrangler.free.toml),
  // which drives the reconcile pass every 6h WITHOUT consuming a Workers-Free cron slot.
  // Idempotent (ensureAlarm only sets an alarm when none is pending), so it is safe to call
  // after every deploy. On the paid deploy the DO is not bound (Cron Trigger drives reconcile)
  // and this returns 503 — harmless, since the paid path never calls it.
  app.post("/internal/reconcile/kick", async (c) => {
    const ns = (c.env as Env).RECONCILE_DO;
    if (!ns) return c.json({ error: "RECONCILE_DO not bound" }, 503);
    const stub = ns.get(ns.idFromName("singleton"));
    const res = await stub.fetch("https://github-reconcile-do/internal/ensure-alarm", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as unknown;
    return c.json({ ok: true, kicked: true, do: body });
  });

  // Request context (requestId / correlation) for the externally reachable surface. Not
  // authorization — that is already done above, for every route including the ones here.
  app.use("*", dubContext());

  // ---- links ----
  app.get("/github/links", async (c) => {
    const ctx = ctxOf(c);
    const syncState = c.req.queries("syncState");
    const q = {
      ...(c.req.query("taskId") ? { taskId: c.req.query("taskId")! } : {}),
      ...(c.req.query("repo") ? { repo: c.req.query("repo")! } : {}),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
      ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
    };
    const res = await deps.service.listLinks(ctx.requestId, q);
    return c.json(res);
  });

  app.post("/github/links", async (c) => {
    const ctx = ctxOf(c);
    const body = await jsonBody<CreateLinkRequest>(c);
    const link = await deps.service.createLink(ctx.requestId, body);
    return c.json(link, 201);
  });

  app.delete("/github/links/:id", async (c) => {
    const ctx = ctxOf(c);
    await deps.service.deleteLink(ctx.requestId, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- repos ----
  app.get("/github/repos", async (c) => {
    const ctx = ctxOf(c);
    const eventId = c.req.query("eventId");
    const cursor = c.req.query("cursor") ?? null;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const res = await deps.service.listRepos(ctx.requestId, eventId, cursor, limit);
    return c.json(res);
  });

  app.post("/github/repos", async (c) => {
    const ctx = ctxOf(c);
    const userId = c.get("userId");
    const body = await jsonBody<RegisterRepoRequest>(c);
    const repo = await deps.service.registerRepo(ctx.requestId, userId, body);
    await audit(deps, ctx, userId, "github.repo.registered", repo.id, { owner: repo.owner, repo: repo.repo });
    return c.json(repo, 201);
  });

  app.patch("/github/repos/:id", async (c) => {
    const ctx = ctxOf(c);
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body = await jsonBody<UpdateRepoRequest>(c);
    const repo = await deps.service.updateRepo(ctx.requestId, id, body);
    await audit(deps, ctx, userId, "github.repo.updated", id, { changed: Object.keys(body) });
    return c.json(repo);
  });

  app.delete("/github/repos/:id", async (c) => {
    const ctx = ctxOf(c);
    const userId = c.get("userId");
    const id = c.req.param("id");
    await deps.service.deleteRepo(ctx.requestId, id);
    await audit(deps, ctx, userId, "github.repo.deregistered", id, null);
    return c.body(null, 204);
  });

  // ---- sync ----
  app.post("/github/sync", async (c) => {
    const ctx = ctxOf(c);
    const userId = c.get("userId");
    const body = await jsonBody<Parameters<GithubSyncService["triggerSync"]>[2]>(c);
    const res = await deps.service.triggerSync(ctx.requestId, userId, body);
    await audit(deps, ctx, userId, "github.sync.triggered", res.runId, { scope: body.scope });
    return c.json(res, 202);
  });

  app.get("/github/sync/runs", async (c) => {
    const cursor = c.req.query("cursor") ?? null;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const res = await deps.service.listRuns(cursor, limit);
    return c.json(res);
  });

  app.get("/github/sync/runs/:id", async (c) => {
    const run = await deps.service.getRun(c.req.param("id"));
    return c.json(run);
  });

  return app;
}

async function audit(
  deps: AppDeps,
  ctx: RequestContext,
  userId: string,
  action: string,
  resourceId: string,
  details: Record<string, unknown> | null,
): Promise<void> {
  const rec: auditLog.AuditRecordInput = {
    action,
    actorId: userId,
    orgId: common.DUB_DEFAULT_ORG_ID,
    result: "success",
    resourceType: "github_repo",
    resourceId,
    details,
    requestId: ctx.requestId,
    occurredAt: deps.now(),
  };
  await deps.publisher.audit(rec);
}
