// Upstream clients used by the gateway's OWN composition calls (/me, /bff/home) and
// entry verify. These are genuine service-to-service calls, so @dub/http attaches
// x-dub-internal (required to reach identity's /internal/* permissions endpoint).
// NOTE: transparent proxy forwarding does NOT use these (see proxy.ts) — it must
// never set x-dub-internal on forwarded external requests.
import { createServiceClient, type ServiceClient } from "@dub/http";
import { createAuthClient, type AuthClient } from "@dub/auth-client";
import type { GatewayEnv } from "./env";

export const CALLER = "api-gateway";

export interface GatewayServices {
  identity: ServiceClient;
  event: ServiceClient;
  notification: ServiceClient;
  auth: AuthClient; // mode:"verify" — the entry one-shot verify
  // Service-to-service client to auth-service for the admin/self password composition
  // handlers (/api/v1/me/password, /api/v1/admin/users/:id/password). Unlike the
  // transparent proxy, these are genuine gateway-originated calls: this client attaches
  // x-dub-internal (+ x-dub-user-id from ctx), which the auth-service internal-only admin
  // routes require. Password mutations are NOT retried (POST without an idempotency key).
  authSvc: ServiceClient;
}

export function createServices(env: GatewayEnv): GatewayServices {
  return {
    identity: createServiceClient(env.SVC_IDENTITY, { service: "identity-roster", caller: CALLER }),
    event: createServiceClient(env.SVC_EVENT, { service: "event-service", caller: CALLER }),
    notification: createServiceClient(env.SVC_NOTIFICATION, { service: "notification-service", caller: CALLER }),
    authSvc: createServiceClient(env.SVC_AUTH, { service: "auth-service", caller: CALLER }),
    auth: createAuthClient({
      identityBinding: env.SVC_IDENTITY,
      authBinding: env.SVC_AUTH,
      serviceName: CALLER,
      mode: "verify",
    }),
  };
}
