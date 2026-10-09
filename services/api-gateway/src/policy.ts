// How api-gateway mounts @dub/policy-gate. Two things are specific to this service because
// it is the edge, and both are the reason this file exists instead of a one-line mount.
//
// 1. THE ACTOR IS THE SESSION, NEVER THE HEADER.
//    Every other service lets the gate read `x-dub-user-id`, which is trustworthy there
//    precisely because this service produced it. Here that header is attacker-controlled: a
//    request arriving from the internet can carry any value, and proxy.ts strips the whole
//    x-dub-* family for exactly that reason. If the gate believed it at the edge, anyone
//    could send `x-dub-user-id: <an admin's id>` and read that admin's plaintext password
//    through GET /api/v1/admin/users/:userId/password. So the gate is given an ActorResolver
//    that performs the real entry verify (auth-service) and nothing else:
//    `x-dub-user-id` is never read on a gateway-owned route. test/policy-table.test.ts pins
//    that with a spoofed header.
//
// 2. THE GRANTER IS PER REQUEST.
//    `createApp()` runs once per isolate (index.ts), so there is no `env` at mount time,
//    while `createAuthzGranter` needs the SVC_IDENTITY binding. The middleware below is
//    therefore a thin wrapper that builds the gate's dependencies from `c.env` and delegates
//    to the real `policyGate` — the decision logic stays in the package, none of it is
//    re-implemented here.
//
// Authentication happens at most ONCE per request: the resolver caches the verified session
// in `c.set("authed", ...)`, and handlers read it back through `authedActor(c)` instead of
// verifying again (the proxy path, which the gate does not authenticate, calls
// `authenticateOnce` itself). One inbound request = one auth-service verify, as before.
import type { Context, MiddlewareHandler } from "hono";
import { createAuthzGranter, policyGate, type PermissionGranter } from "@dub/policy-gate";
import type { GatewayEnv } from "./env";
import type { GatewayVariables } from "./context";
import { getRequestId } from "./context";
import { createServices } from "./services";
import { authenticate, type Authenticated } from "./auth";
import { POLICY_TABLE } from "./policy-table";

export const SERVICE = "api-gateway";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/**
 * Entry verify, memoized per request. Throws the usual 401 (missing/invalid token) or 502
 * (auth-service unreachable) — the gate lets a resolver's own DubError through untouched, so
 * clients keep seeing the same error they always did for the same cause.
 */
export async function authenticateOnce(c: Ctx): Promise<Authenticated> {
  const cached = c.get("authed");
  if (cached) return cached;
  const authed = await authenticate(createServices(c.env).auth, { requestId: getRequestId(c) }, c.req.raw.headers);
  c.set("authed", authed);
  return authed;
}

/**
 * The session a gated handler can rely on. Non-null by construction: the gate authenticated
 * every AUTHENTICATED / key-gated route before the handler ran, so an absent value means the
 * route's table entry is PUBLIC (or missing) while its handler assumes a user — a wiring bug,
 * not a client error, hence a 500 rather than a quiet 401.
 */
export function authedActor(c: Ctx): Authenticated {
  const authed = c.get("authed");
  if (!authed) {
    throw new Error(`${SERVICE}: no authenticated session on a route whose handler requires one (check POLICY_TABLE)`);
  }
  return authed;
}

export interface GatewayPolicyGateOptions {
  /** Override the permission source (tests). Production builds one from SVC_IDENTITY. */
  authz?: PermissionGranter;
}

/** THE authorization layer for everything api-gateway serves itself. Mounted once, in app.ts. */
export function gatewayPolicyGate(
  options: GatewayPolicyGateOptions = {},
): MiddlewareHandler<{ Bindings: GatewayEnv; Variables: GatewayVariables }> {
  return (c, next) => {
    const granted =
      options.authz ??
      createAuthzGranter(c.env.SVC_IDENTITY, { caller: SERVICE, requestId: getRequestId(c) });
    const gate = policyGate({
      service: SERVICE,
      table: POLICY_TABLE,
      granted,
      actor: (ctx) => authenticateOnce(ctx as Ctx).then((a) => a.userId),
    });
    // The gate publishes `userId: string`; GatewayVariables declares it optional (the proxy
    // path has no gate-set user). Structurally compatible in one direction only, so the cast
    // is at this single seam rather than spread through the app's types.
    return (gate as unknown as MiddlewareHandler<{ Bindings: GatewayEnv; Variables: GatewayVariables }>)(c, next);
  };
}
