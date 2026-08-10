// Hono app: 2 write routes (internal-only), 2 read routes (audit:read gated), health.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createDbClient, ulid } from "@dub/db";
import { dubErrorHandler, errors } from "@dub/errors";
import { dubContext } from "@dub/http";
import { createAuthClient } from "@dub/auth-client";
import { HEADERS } from "@dub/observability";
import type { auditLog } from "@dub/types";
import type { AppBindings } from "./env";
import { SERVICE_NAME } from "./config";
import { parseAuditRecordInput, assertSyncAction, parseAuditLogQuery, parseAuditEnvelope } from "./validation";
import { insertRecord, getById, queryLogs } from "./repo";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const db = (c: Context<AppBindings>) =>
    createDbClient(c.env.DB, { namespace: "audit", requestId: c.get("dubCtx").requestId });

  // ---- internal-only guard: /internal/* requires the x-dub-internal marker.
  // Mirrors the gateway internalOnlyPaths 404 (never expose write routes publicly).
  app.use("/internal/*", async (c, next) => {
    if (!c.req.header(HEADERS.internal)) throw errors.notFound("route", c.req.path);
    await next();
  });

  // ---- health
  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

  // ---- write (sync, fail-close): only the 5 SYNC_AUDIT_ACTIONS are accepted here.
  app.post("/internal/log", async (c) => {
    const body = await c.req.json().catch(() => null);
    const input = parseAuditRecordInput(body);
    assertSyncAction(input.action);
    // id = caller idempotency key (retry-safe) or a fresh bare ULID.
    const id = c.req.header(HEADERS.idempotencyKey) ?? ulid();
    await insertRecord(db(c), id, input);
    const res: auditLog.AuditLogWriteResponse = { id };
    return c.json(res, 201);
  });

  // ---- write (async ingest, open catalog): the free-tier @dub/freeq outbox drain
  // (auth-service, over its SVC_AUDIT service binding) forwards each due row here as an
  // AuditRecordEnvelopeV1 — the SAME envelope the retired Queue consumer understood.
  // Unlike /internal/log there is NO SYNC_AUDIT_ACTIONS gate: this is the landing route
  // for the open-vocabulary async actions (auth.session.login, auth.session.logout, ...).
  // The envelope id is the producer idempotency key; insertRecord is INSERT OR IGNORE so
  // at-least-once re-delivery is safe. A 4xx (bad envelope) or 5xx (DB) is non-2xx, which
  // the drain treats as failure -> the outbox row stays pending and retries (never lost).
  app.post("/internal/audit-async", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { id, input } = parseAuditEnvelope(body);
    await insertRecord(db(c), id, input);
    const res: auditLog.AuditLogWriteResponse = { id };
    return c.json(res, 202);
  });

  // ---- read: audit:read (P0 = admin). Build one auth client per request.
  app.use("/audit/*", async (c, next) => {
    const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
    c.set("authClient", client);
    await next();
  });
  const requireAuth: MiddlewareHandler<AppBindings> = (c, next) => c.get("authClient").requireAuth()(c, next);
  const requireAuditRead: MiddlewareHandler<AppBindings> = (c, next) =>
    c.get("authClient").requirePermission("audit:read")(c, next);

  app.get("/audit/logs", requireAuth, requireAuditRead, async (c) => {
    const query = parseAuditLogQuery(c.req.query());
    const page = await queryLogs(db(c), query);
    return c.json(page);
  });

  app.get("/audit/logs/:id", requireAuth, requireAuditRead, async (c) => {
    const record = await getById(db(c), c.req.param("id"));
    if (!record) throw errors.notFound("audit_log", c.req.param("id"));
    return c.json(record);
  });

  return app;
}
