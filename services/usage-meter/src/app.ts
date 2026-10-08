// usage-meter HTTP surface (Hono). The real collection runs in the MeterDO alarm
// (meter-do.ts); fetch serves:
//   - GET  /internal/health                 liveness
//   - GET  /                                Worker root
//   - POST /internal/meter/kick             arm the DO daily-alarm loop
//   - POST /internal/meter/refresh          on-demand re-collect + upsert, returns summary
//   - GET  /usage/summary                   the frozen dashboard contract
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives both authn (the trusted
// x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which lists every
// route below. Handlers therefore assume an authorized caller and read it with
// `c.get("userId")`. Do NOT add a permission check, a `requireAuth`, or an inline
// `x-dub-internal` test to a route or a handler — add the route to the table
// (test/policy-table.test.ts fails if you forget).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { dubErrorHandler, errors } from "@dub/errors";
import { HEADERS } from "@dub/observability";
import { policyGate, sharedAuthzGranter, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { Env } from "./env";
import { collectSnapshot } from "./collect";
import { POLICY_TABLE } from "./policy-table";
import { mailReadDb, readLatestSnapshot, upsertSnapshot, usageDb } from "./snapshot-repo";
import { buildSummary } from "./summary";

const SERVICE_NAME = "usage-meter";

type AppBindings = { Bindings: Env; Variables: PolicyGateVars };

export interface AppOptions {
  /** Override the permission source (tests). Production derives one from SVC_IDENTITY. */
  authz?: PermissionGranter;
}

/**
 * THE authorization layer, as a thin per-request wrapper around the real `policyGate`.
 *
 * WHY a wrapper and not a one-line mount: `createApp()` runs once per isolate (index.ts), so
 * there is no `env` at mount time, while the granter needs the SVC_IDENTITY binding. The
 * wrapper builds the gate's dependencies from `c.env` and delegates — no decision logic is
 * re-implemented here. (Same shape as api-gateway's `gatewayPolicyGate`.)
 *
 * The SVC_IDENTITY lookup happens INSIDE the granter rather than here, so the four INTERNAL
 * routes still answer when the binding is absent: the gate only calls the granter for a rule
 * that names keys, which in this table is `GET /usage/summary` alone. When it IS called without
 * the binding it throws, i.e. fail-closed — the same 502 the removed `requireViewer` raised for
 * the same cause, never a quiet allow.
 */
function usageMeterPolicyGate(options: AppOptions): MiddlewareHandler<AppBindings> {
  return (c, next) => {
    const granted: PermissionGranter =
      options.authz ??
      ((userId, orgId, keys) => {
        const binding = c.env.SVC_IDENTITY;
        if (!binding) throw errors.upstreamUnavailable("identity-roster");
        const requestId = c.req.header(HEADERS.requestId);
        return sharedAuthzGranter(c.env, binding, {
          caller: SERVICE_NAME,
          ...(requestId ? { requestId } : {}),
        })(userId, orgId, keys);
      });
    const gate = policyGate({ service: SERVICE_NAME, table: POLICY_TABLE, granted });
    // The gate declares only `Variables` (it knows nothing about a service's Bindings), so the
    // two handler types are structurally compatible in one direction only. Cast once, here,
    // instead of letting it spread through the app's types.
    return (gate as unknown as MiddlewareHandler<AppBindings>)(c, next);
  };
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppBindings>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  // First and only — every route below is gated by POLICY_TABLE.
  app.use("*", usageMeterPolicyGate(options));

  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));
  app.get("/", (c) => c.text(SERVICE_NAME));

  // ---- bootstrap the DO daily-alarm loop (idempotent). INTERNAL in the table. ----
  app.post("/internal/meter/kick", async (c) => {
    const ns = c.env.METER_DO;
    if (!ns) return c.json({ error: "METER_DO not bound" }, 503);
    const stub = ns.get(ns.idFromName("singleton"));
    const res = await stub.fetch("https://usage-meter-do/internal/ensure-alarm", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as unknown;
    return c.json({ ok: true, kicked: true, do: body });
  });

  // ---- on-demand re-collect + upsert (no alerting; alerts fire only in the DO alarm). ----
  app.post("/internal/meter/refresh", async (c) => {
    if (!c.env.DB) return c.json({ error: "DB not bound" }, 503);
    const now = new Date();
    const rows = await collectSnapshot(c.env, mailReadDb(c.env.DB), now);
    await upsertSnapshot(usageDb(c.env.DB), rows, now);
    return c.json(buildSummary(rows, now));
  });

  // ---- the dashboard read. appLevel("usage","view") + usage:view in the table. ----
  app.get("/usage/summary", async (c: Context<AppBindings>) => {
    if (!c.env.DB) return c.json({ error: "DB not bound" }, 503);
    const rows = await readLatestSnapshot(usageDb(c.env.DB));
    return c.json(buildSummary(rows, new Date()));
  });

  return app;
}
