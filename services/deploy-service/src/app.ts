// Hono app assembly. Middleware order: x-dub-* context -> per-request deps -> policyGate
// -> routes.
//
// AUTHZ: none in this file and none in any route file. `policyGate` is the single decision
// point; it derives both authn (the trusted x-dub-user-id header) and authz from
// POLICY_TABLE (src/policy-table.ts), which lists every endpoint this Worker serves. A route
// missing from the table is denied (403), not served. Handlers therefore assume an
// authorized caller and read it with `reqCtx(c)` / `c.get("userId")`. Do NOT add a
// permission check to a route or a handler — add the route to the table
// (test/policy-table.test.ts fails if you forget). Resource-instance checks DO stay in the
// handlers: the allowed-zone gate in routes/dns.ts is one, and it is not a key check.
import { Hono, type MiddlewareHandler } from "hono";
import { dubContext } from "@dub/http";
import { dubErrorHandler } from "@dub/errors";
import { policyGate } from "@dub/policy-gate";
import type { AppEnv } from "./http";
import { getDeps } from "./http";
import { buildDeps, SERVICE_NAME } from "./deps";
import type { DepsFactory } from "./deps";
import { POLICY_TABLE } from "./policy-table";
import { registerSiteRoutes } from "./routes/sites";
import { registerDeploymentRoutes } from "./routes/deployments";
import { registerDnsRoutes } from "./routes/dns";
import { registerDomainRoutes } from "./routes/domains";

export function createApp(makeDeps: DepsFactory = buildDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));

  // x-dub-* parsing (deploy-service is never an entrypoint: requestId must be present).
  app.use("*", dubContext({ allowGenerate: false }));

  // per-request dependency container
  app.use("*", async (c, next) => {
    const ctx = c.get("dubCtx");
    c.set("deps", makeDeps(c.env, ctx.requestId));
    await next();
  });

  // THE authorization layer. It runs before every handler below (and before any route added
  // later), so the fail-closed property holds for the whole surface. The two mounts above it
  // are plumbing only — x-dub-* header parsing and the DI container — and neither can allow
  // or deny a request; the gate is built here because its granter lives in those deps, which
  // are per-request. `as MiddlewareHandler` is a typing bridge only: policyGate is declared
  // for an app whose Variables are exactly PolicyGateVars, while this app's also carry deps,
  // dubCtx and Bindings, and Hono's Context<E> is not comparable across that difference.
  app.use("*", (c, next) => {
    const gate = policyGate({
      service: SERVICE_NAME,
      table: POLICY_TABLE,
      granted: getDeps(c).authz,
    }) as MiddlewareHandler;
    return gate(c, next);
  });

  app.get("/health", (c) => c.json({ ok: true, service: SERVICE_NAME }));

  registerSiteRoutes(app);
  registerDeploymentRoutes(app);
  registerDnsRoutes(app);
  registerDomainRoutes(app);

  return app;
}
