// Hono app: 2 write routes (internal-only), 2 read routes (audit:read gated), health.
//
// AUTHZ: none in this file. `policyGate` is the first decision point and the only one — it
// derives both authn (the trusted x-dub-user-id header) and authz from POLICY_TABLE
// (src/policy-table.ts), which lists every route below. Handlers therefore assume an
// authorized caller. Do NOT add a permission check or an `x-dub-internal` check to a route
// or a handler — add the route to the table (test/policy-table.test.ts fails if you forget).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createDbClient, ulid } from "@dub/db";
import { dubErrorHandler, errors } from "@dub/errors";
import { dubContext } from "@dub/http";
import { policyGate, sharedAuthzGranter } from "@dub/policy-gate";
import { HEADERS } from "@dub/observability";
import type { auditLog } from "@dub/types";
import type { AppBindings } from "./env";
import { SERVICE_NAME } from "./config";
import { POLICY_TABLE } from "./policy-table";
import { parseAuditRecordInput, assertSyncAction, parseAuditLogQuery, parseAuditIngest } from "./validation";
import { insertRecord, getById, queryLogs } from "./repo";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const db = (c: Context<AppBindings>) =>
    createDbClient(c.env.DB, { namespace: "audit", requestId: c.get("dubCtx").requestId });

  // ---- THE authorization layer. Mounted on every route, so it runs before every handler,
  // including routes added below it; a route absent from POLICY_TABLE is denied (403), never
  // served. It replaces BOTH the old per-route requireAuth/requirePermission("audit:read")
  // pair AND the hand-rolled "/internal/* needs x-dub-internal" middleware — the latter is
  // now the INTERNAL rule form, so the internal-only routes are visible in the table instead
  // of hiding in a middleware. `dubContext` above is pure x-dub-* header parsing (it makes
  // no authorization decision) and stays first so the gate's identity /authz/check call
  // carries this request's correlation id.
  //
  // The granter needs the identity Service Binding, which only exists per request (c.env),
  // so the gate instance is built here rather than at module scope. `as MiddlewareHandler`
  // is a typing bridge only: policyGate is declared for an app whose Variables are exactly
  // PolicyGateVars, while this app's Vars EXTENDS PolicyGateVars and adds Bindings, and
  // Hono's Context<E> is not comparable across that difference.
  app.use("*", (c, next) => {
    const gate = policyGate({
      service: SERVICE_NAME,
      table: POLICY_TABLE,
      // sharedAuthzGranter, not createAuthzGranter: the decision cache ADR 0004 requires is
      // memoized per Env, so it survives across requests served by the same isolate instead
      // of being freshly empty on every one (identity-roster sits on the hot path).
      granted: sharedAuthzGranter(c.env, c.env.SVC_IDENTITY, {
        caller: SERVICE_NAME,
        requestId: c.get("dubCtx").requestId,
      }),
    }) as MiddlewareHandler;
    return gate(c, next);
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

  // ---- write (async ingest, open catalog): the free-tier @dub/freeq outbox drain forwards
  // each due row here. Two accepted shapes (see parseAuditIngest): the canonical
  // AuditRecordEnvelopeV1 that current producers enqueue, AND a LEGACY FLAT AuditRecordInput
  // from the pre-fix auth-outbox producer (backward-compat so the pending backlog drains).
  // Unlike /internal/log there is NO SYNC_AUDIT_ACTIONS gate: this is the landing route for
  // the open-vocabulary async actions (auth.session.login, auth.session.logout, ...). The id
  // (envelope id, or a deterministic content hash for flat rows) is the idempotency key;
  // insertRecord is INSERT OR IGNORE so at-least-once re-delivery is safe. A 4xx (bad body)
  // or 5xx (DB) is non-2xx, which the drain treats as failure -> the row stays pending and
  // retries (never lost).
  app.post("/internal/audit-async", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { id, input } = await parseAuditIngest(body);
    await insertRecord(db(c), id, input);
    const res: auditLog.AuditLogWriteResponse = { id };
    return c.json(res, 202);
  });

  // ---- read: audit:read (P0 = admin), demanded by the table — see policy-table.ts.
  app.get("/audit/logs", async (c) => {
    const query = parseAuditLogQuery(c.req.query());
    const page = await queryLogs(db(c), query);
    return c.json(page);
  });

  app.get("/audit/logs/:id", async (c) => {
    const record = await getById(db(c), c.req.param("id"));
    if (!record) throw errors.notFound("audit_log", c.req.param("id"));
    return c.json(record);
  });

  return app;
}
