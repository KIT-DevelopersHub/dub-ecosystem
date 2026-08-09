// App wiring. Middleware order: CORS (answers preflight) -> requestId -> rate limit,
// then gateway-owned routes, then the transparent /api/v1/* catch-all, then 404.
import { Hono } from "hono";
import type { GatewayEnv } from "./env";
import { requestIdMiddleware, gatewayErrorHandler, gatewayError, GATEWAY_ROUTE_NOT_FOUND, type GatewayVariables } from "./context";
import { corsMiddleware } from "./cors";
import { rateLimitMiddleware, createInMemoryRateLimiter, type RateLimiter } from "./rate-limit";
import { healthzHandler } from "./handlers/healthz";
import { meHandler } from "./handlers/me";
import { bffHomeHandler } from "./handlers/bff-home";
import { createPublicInquiryHandler } from "./handlers/public-inquiry";
import { gatewayRouteHandler } from "./gateway-route";
import type { TurnstileVerifier } from "./turnstile";

export interface CreateAppOptions {
  /** override Turnstile verifier (tests). Defaults to secret-bound siteverify at runtime. */
  turnstile?: TurnstileVerifier;
  /** override rate limiter (tests / infra native binding). Defaults to in-memory fixed window. */
  rateLimiter?: RateLimiter;
}

export type GatewayApp = Hono<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

export function createApp(options: CreateAppOptions = {}): GatewayApp {
  const app = new Hono<{ Bindings: GatewayEnv; Variables: GatewayVariables }>();
  const limiter = options.rateLimiter ?? createInMemoryRateLimiter();

  app.onError(gatewayErrorHandler);

  app.use("*", corsMiddleware());
  app.use("*", requestIdMiddleware());
  app.use("*", rateLimitMiddleware(limiter));

  // liveness (public, not under API_PREFIX)
  app.get("/healthz", healthzHandler);

  // gateway-owned (composition / public receipt)
  app.get("/api/v1/me", meHandler);
  app.get("/api/v1/bff/home", bffHomeHandler);
  app.post("/api/v1/public/inquiries", createPublicInquiryHandler(options.turnstile));

  // transparent routing for everything else under the API prefix
  app.all("/api/v1/*", gatewayRouteHandler);

  // anything not under the API prefix
  app.all("*", (c) => {
    throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${new URL(c.req.url).pathname}`, 404);
  });

  return app;
}
