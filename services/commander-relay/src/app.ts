// commander-relay HTTP surface (Hono), reached over the api-gateway service binding:
//   - GET  /health                    liveness
//   - POST /commander/relay/ticket    60s ws-ticket + the wss URL to open with it
//   - GET  /commander/relay/status    is the operator's local agent connected?
//
// AUTHZ: `policyGate` is mounted first and enforces POLICY_TABLE; the only extra check is the
// optional owner allow-list (deployment config, not a role permission — see env.ts).
import { Hono, type MiddlewareHandler } from "hono";
import { dubErrorHandler, errors } from "@dub/errors";
import { HEADERS } from "@dub/observability";
import { policyGate, sharedAuthzGranter, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import type { Env } from "./env";
import { POLICY_TABLE } from "./policy-table";
import { signTicket, TICKET_TTL_SEC } from "./ticket";

const SERVICE_NAME = "commander-relay";

type AppBindings = { Bindings: Env; Variables: PolicyGateVars };

export interface AppOptions {
  /** Override the permission source (tests). Production derives one from SVC_IDENTITY. */
  authz?: PermissionGranter;
}

// Per-request wrapper: the granter needs c.env.SVC_IDENTITY, which does not exist at mount
// time (same shape as usage-meter's gate). Missing binding -> throws -> fail closed.
function relayPolicyGate(options: AppOptions): MiddlewareHandler<AppBindings> {
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
    return (gate as unknown as MiddlewareHandler<AppBindings>)(c, next);
  };
}

function owners(env: Env): string[] {
  return (env.COMMANDER_OWNER_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppBindings>();
  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", relayPolicyGate(options));

  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

  app.post("/commander/relay/ticket", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "unauthenticated" }, 401);
    const secret = c.env.RELAY_TICKET_SECRET;
    const wsUrl = c.env.RELAY_WS_URL;
    // Fail closed: with no owner configured, nobody gets a ticket (not "every editor").
    const allowed = owners(c.env);
    if (!secret || !wsUrl || allowed.length === 0) return c.json({ error: "relay_not_configured" }, 503);
    if (!allowed.includes(userId)) return c.json({ error: "not_owner" }, 403);
    const ticket = await signTicket(secret, userId);
    return c.json({ ticket, wsUrl, expiresInSec: TICKET_TTL_SEC });
  });

  app.get("/commander/relay/status", async (c) => {
    const ns = c.env.RELAY;
    if (!ns) return c.json({ error: "relay_not_configured" }, 503);
    const res = await ns.get(ns.idFromName("owner")).fetch("https://relay/status");
    return c.json((await res.json()) as Record<string, unknown>);
  });

  return app;
}
