// App wiring. Middleware order: CORS (answers preflight) -> requestId -> rate limit ->
// policy gate, then gateway-owned routes, then the transparent API_PREFIX/* catch-all,
// then 404.
//
// AUTHZ: none in this file or in any handler. `gatewayPolicyGate` is the single
// authorization layer and derives every decision from POLICY_TABLE (src/policy-table.ts),
// which lists all 12 gateway-owned routes. Do NOT add a permission check to a route or a
// handler — add the route to the table (test/policy-table.test.ts fails if you forget).
// Proxied /api/v1/* routes are authorized by the service that owns them (see policy-table.ts
// for why the catch-all is deliberately not a table entry).
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
import { gatewayPolicyGate } from "./policy";
import type { PermissionGranter } from "@dub/policy-gate";
import type { TurnstileVerifier } from "./turnstile";

export interface CreateAppOptions {
  /** override Turnstile verifier (tests). Defaults to secret-bound siteverify at runtime. */
  turnstile?: TurnstileVerifier;
  /** override rate limiter (tests / infra native binding). Defaults to in-memory fixed window. */
  rateLimiter?: RateLimiter;
  /** override the permission source the policy gate consults (tests). Defaults to identity. */
  authz?: PermissionGranter;
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

  // THE authorization layer — first and only, ahead of every route below. It is mounted
  // AFTER these three on purpose, and the order is load-bearing:
  //   cors      must answer the preflight. An OPTIONS request carries no credentials by
  //             spec, so authorizing it is meaningless; gating it would make the browser
  //             report a CORS failure for every cross-origin call the SPA makes.
  //   requestId the gate's 401/403 are thrown as DubErrors and formatted by onError, which
  //             stamps the correlation id — mounting the gate first would mint a fresh id
  //             instead of inheriting the caller's x-dub-request-id on exactly the
  //             responses that most need tracing.
  //   rateLimit an unauthenticated flood must be cheap to refuse. Gating first would run an
  //             auth-service verify per hostile request, and it would also flip the
  //             established 429-before-401 precedence.
  // Nothing in those three makes an authorization decision, so the gate is still the only
  // place where one is made.
  app.use("*", gatewayPolicyGate(options.authz ? { authz: options.authz } : {}));

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

  // Transparent routing for everything else under the API prefix. `app.all` is deliberate
  // (and the one exception to the inventory's 4.4 ban): this is a pass-through MOUNT whose
  // authorization decision belongs to the downstream service, so the gate must let it by —
  // which is exactly what Hono's ALL + "/*" registration means to `matchedRouteKey`. The
  // concrete-method routes above always win the same match, so they stay gated. Full
  // reasoning, and the test that keeps this from becoming a loophole, in policy-table.ts.
  app.all(`${API_PREFIX}/*`, gatewayRouteHandler);

  // anything not under the API prefix
  app.all("*", (c) => {
    throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${new URL(c.req.url).pathname}`, 404);
  });

  return app;
}
