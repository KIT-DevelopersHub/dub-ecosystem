// usage-meter HTTP surface (Hono). The real collection runs in the MeterDO alarm
// (meter-do.ts); fetch serves:
//   - GET  /internal/health                 liveness
//   - POST /internal/meter/kick             arm the DO daily-alarm loop (internal-only)
//   - POST /internal/meter/refresh          on-demand re-collect + upsert, returns summary
//   - GET  /usage/summary                   the frozen dashboard contract (auth only)
// The /internal/* routes require the x-dub-internal Service-Binding marker (never reachable
// from the public internet — workers_dev=false, and the gateway never forwards that marker).
// /usage/summary is reached externally through api-gateway (segment "usage", auth=required),
// which forwards x-dub-user-id; we re-check the caller is authenticated. The real usage
// numbers are safe to show to everyone signed in (there is nothing to hide), so viewing
// needs authentication but no special permission — the data is a read-only D1 snapshot.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { errors, dubErrorHandler } from "@dub/errors";
import { HEADERS } from "@dub/observability";
import { createAuthClient } from "@dub/auth-client";
import type { Env } from "./env";
import { collectSnapshot } from "./collect";
import { mailReadDb, readLatestSnapshot, upsertSnapshot, usageDb } from "./snapshot-repo";
import { buildSummary } from "./summary";

const SERVICE_NAME = "usage-meter";

type AppBindings = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppBindings>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));
  app.get("/", (c) => c.text("usage-meter"));

  // ---- bootstrap the DO daily-alarm loop (idempotent). Internal-only. ----
  app.post("/internal/meter/kick", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    const ns = c.env.METER_DO;
    if (!ns) return c.json({ error: "METER_DO not bound" }, 503);
    const stub = ns.get(ns.idFromName("singleton"));
    const res = await stub.fetch("https://usage-meter-do/internal/ensure-alarm", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as unknown;
    return c.json({ ok: true, kicked: true, do: body });
  });

  // ---- on-demand re-collect + upsert (no alerting; alerts fire only in the DO alarm). ----
  app.post("/internal/meter/refresh", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    if (!c.env.DB) return c.json({ error: "DB not bound" }, 503);
    const now = new Date();
    const rows = await collectSnapshot(c.env, mailReadDb(c.env.DB), now);
    await upsertSnapshot(usageDb(c.env.DB), rows, now);
    return c.json(buildSummary(rows, now));
  });

  // ---- the dashboard read (auth only; any signed-in user may view). ----
  app.get("/usage/summary", requireViewer, async (c) => {
    if (!c.env.DB) return c.json({ error: "DB not bound" }, 503);
    const rows = await readLatestSnapshot(usageDb(c.env.DB));
    return c.json(buildSummary(rows, new Date()));
  });

  return app;
}

// requireAuth only (trusted x-dub-user-id from the gateway). No special permission: the
// free-tier usage numbers are safe for every signed-in user, so we gate on authentication
// alone. requireAuth runs in the default "trustedHeader" mode and never calls identity.
const requireViewer: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.env.SVC_IDENTITY) throw errors.upstreamUnavailable("identity-roster");
  const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
  return client.requireAuth()(c as unknown as Context, next);
};
