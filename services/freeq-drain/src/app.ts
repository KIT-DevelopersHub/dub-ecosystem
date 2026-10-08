// Minimal HTTP surface. A Worker needs a default export with a fetch handler; freeq-drain
// does its real work in the DO alarm (src/drain-do.ts), so fetch serves only a health probe,
// the Worker root, and the one-shot POST /internal/drain/kick that arms the DO alarm after a
// deploy.
//
// AUTHZ: none in this file. `policyGate` is mounted first and derives every decision from
// POLICY_TABLE (src/policy-table.ts), which lists all three routes as INTERNAL. The inline
// `x-dub-internal` comparison that used to guard the kick is GONE — it is the table's INTERNAL
// rule now (see policy-table.ts for why presence-only is not a loosening). Do NOT add a check
// back to a route or a handler: add the route to the table instead
// (test/policy-table.test.ts fails if you forget).
import { dubErrorHandler } from "@dub/errors";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import { Hono } from "hono";
import type { Env } from "./env";
import { POLICY_TABLE } from "./policy-table";

const SERVICE_NAME = "freeq-drain";

/**
 * The gate's PermissionGranter port, deliberately unimplementable here.
 *
 * Every rule in POLICY_TABLE is `INTERNAL`, which demands no permission key, so the gate never
 * reaches the granter (gate.ts returns from the INTERNAL branch before it). This service also
 * has nothing to implement one WITH: it holds no identity binding, and the drain's authority
 * comes from its own D1/Service bindings rather than from an acting user.
 *
 * Throwing (rather than returning `[]`) is the point. `[]` would mean "the caller holds none of
 * the requested keys", which the gate would turn into a 403 — a plausible-looking answer to a
 * question this service cannot actually answer. Throwing surfaces the real situation: whoever
 * added a key-gated route here must wire a real granter in the same commit.
 */
const noPermissionSource: PermissionGranter = async () => {
  throw new Error(
    `${SERVICE_NAME}: a POLICY_TABLE rule demanded a permission key, but this service has no ` +
      "identity binding to evaluate one (every route is INTERNAL — wire a real granter first)",
  );
};

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: PolicyGateVars }>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: SERVICE_NAME, table: POLICY_TABLE, granted: noPermissionSource }));

  app.get("/internal/health", (c) => c.json({ ok: true, service: SERVICE_NAME }));
  app.get("/", (c) => c.text(SERVICE_NAME));

  // Bootstrap the DO alarm loop. Idempotent (ensureAlarm only sets an alarm when none is
  // pending), so it is safe to call after every deploy. INTERNAL in the table — reachable only
  // over a Service Binding carrying x-dub-internal.
  app.post("/internal/drain/kick", async (c) => {
    const ns = c.env.DRAIN_DO;
    if (!ns) return c.json({ error: "DRAIN_DO not bound" }, 503);
    const stub = ns.get(ns.idFromName("singleton"));
    const res = await stub.fetch("https://freeq-drain-do/internal/ensure-alarm", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as unknown;
    return c.json({ ok: true, kicked: true, do: body });
  });

  return app;
}
