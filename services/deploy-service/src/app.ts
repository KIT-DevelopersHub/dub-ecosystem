// Hono app assembly. Middleware order: x-dub-* context -> per-request deps -> routes.
// Auth (requireAuth/requirePermission) is applied per-route via the deps' auth client.
import { Hono } from "hono";
import { dubContext } from "@dub/http";
import { dubErrorHandler } from "@dub/errors";
import type { AppEnv } from "./http";
import { buildDeps, SERVICE_NAME } from "./deps";
import type { DepsFactory } from "./deps";
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

  app.get("/health", (c) => c.json({ ok: true, service: SERVICE_NAME }));

  registerSiteRoutes(app);
  registerDeploymentRoutes(app);
  registerDnsRoutes(app);
  registerDomainRoutes(app);

  return app;
}
