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
}

export function createServices(env: GatewayEnv): GatewayServices {
  return {
    identity: createServiceClient(env.SVC_IDENTITY, { service: "identity-roster", caller: CALLER }),
    event: createServiceClient(env.SVC_EVENT, { service: "event-service", caller: CALLER }),
    notification: createServiceClient(env.SVC_NOTIFICATION, { service: "notification-service", caller: CALLER }),
    auth: createAuthClient({
      identityBinding: env.SVC_IDENTITY,
      authBinding: env.SVC_AUTH,
      serviceName: CALLER,
      mode: "verify",
    }),
  };
}
