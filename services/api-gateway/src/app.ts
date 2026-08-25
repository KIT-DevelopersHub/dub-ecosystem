// App wiring. Middleware order: CORS (answers preflight) -> requestId -> rate limit,
// then gateway-owned routes, then the transparent API_PREFIX/* catch-all, then 404.
import { Hono } from "hono";
import type { GatewayEnv } from "./env";
import { requestIdMiddleware, gatewayErrorHandler, gatewayError, GATEWAY_ROUTE_NOT_FOUND, type GatewayVariables } from "./context";
import { corsMiddleware } from "./cors";
import { rateLimitMiddleware, createInMemoryRateLimiter, type RateLimiter } from "./rate-limit";
import { healthzHandler } from "./handlers/healthz";
import { meHandler } from "./handlers/me";
import { bffHomeHandler } from "./handlers/bff-home";
import { createPublicInquiryHandler } from "./handlers/public-inquiry";
import { createPublicParticipationHandler } from "./handlers/public-participation";
import { selfPasswordHandler, adminSetPasswordHandler, adminViewPasswordHandler } from "./handlers/passwords";
import { getSelfProfileHandler, updateSelfProfileHandler } from "./handlers/self-profile";
import { getSelfParticipationHandler, updateSelfParticipationHandler } from "./handlers/self-participation";
import { gatewayRouteHandler } from "./gateway-route";
import { API_PREFIX } from "./routes";
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
  // An explicitly injected limiter is authoritative (deterministic tests / infra native
  // binding). Otherwise fall back to the per-isolate in-memory limiter, but prefer a
  // shared KV limiter per request when RATE_LIMIT_KV is bound (see rate-limit.ts).
  const injected = options.rateLimiter;
  const fallback = injected ?? createInMemoryRateLimiter();

  app.onError(gatewayErrorHandler);

  app.use("*", corsMiddleware());
  app.use("*", requestIdMiddleware());
  app.use("*", rateLimitMiddleware(fallback, { preferEnv: injected === undefined }));

  // liveness (public, deliberately NOT under API_PREFIX — root-mounted probe).
  app.get("/healthz", healthzHandler);

  // gateway-owned (composition / public receipt). Mounts derive from the single
  // API_PREFIX source of truth so they can never drift from stripApiPrefix (routes.ts).
  app.get(`${API_PREFIX}/me`, meHandler);
  app.get(`${API_PREFIX}/bff/home`, bffHomeHandler);
  app.post(`${API_PREFIX}/public/inquiries`, createPublicInquiryHandler(options.turnstile));
  // Public 参加届: unauthenticated submit → member-service internal route (roster reflect).
  app.post(`${API_PREFIX}/public/participation`, createPublicParticipationHandler(options.turnstile));

  // Password management (themes #5a/#5b/#5c). Gateway-owned because auth-service's admin
  // routes are internal-only and the `auth` proxy segment strips tokens: these compose
  // entry verify + authorization + a genuine internal forward (see handlers/passwords.ts).
  app.post(`${API_PREFIX}/me/password`, selfPasswordHandler);
  app.post(`${API_PREFIX}/admin/users/:userId/password`, adminSetPasswordHandler);
  app.get(`${API_PREFIX}/admin/users/:userId/password`, adminViewPasswordHandler);

  // Self service (アカウント設定): the signed-in user reads/edits their OWN profile (表示名/
  // アバター → identity-roster) and 参加届 (参加情報 → member-service). Gateway-owned because
  // both back-ends expose only internal (admin- or s2s-gated) writes; these compose entry
  // verify + a genuine internal forward scoped to the caller's session id (no target id).
  app.get(`${API_PREFIX}/me/profile`, getSelfProfileHandler);
  app.post(`${API_PREFIX}/me/profile`, updateSelfProfileHandler);
  app.get(`${API_PREFIX}/me/participation`, getSelfParticipationHandler);
  app.post(`${API_PREFIX}/me/participation`, updateSelfParticipationHandler);

  // transparent routing for everything else under the API prefix
  app.all(`${API_PREFIX}/*`, gatewayRouteHandler);

  // anything not under the API prefix
  app.all("*", (c) => {
    throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${new URL(c.req.url).pathname}`, 404);
  });

  return app;
}
