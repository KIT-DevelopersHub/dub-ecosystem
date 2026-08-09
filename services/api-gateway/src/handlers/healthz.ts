// GET /healthz — liveness (public, no auth). Not under API_PREFIX.
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";

export interface HealthzResponse {
  status: "ok";
  version: string;
  requestId: string;
}

export function healthzHandler(c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>): Response {
  const requestId = getRequestId(c);
  const body: HealthzResponse = { status: "ok", version: c.env.GATEWAY_VERSION ?? "0.0.0", requestId };
  return c.json(body);
}
