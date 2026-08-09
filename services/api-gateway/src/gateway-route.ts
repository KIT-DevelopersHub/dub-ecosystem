// Catch-all handler for /api/v1/* transparent routing: resolve rule -> guards
// (WS reject, body cap, internal-only 404) -> optional entry verify -> forward.
import type { Context } from "hono";
import { errors, DubError, CommonErrorCodes } from "@dub/errors";
import type { GatewayEnv } from "./env";
import { bindingByName } from "./env";
import type { GatewayVariables } from "./context";
import { getRequestId, gatewayError, GATEWAY_ROUTE_NOT_FOUND, GATEWAY_WEBSOCKET_UNSUPPORTED } from "./context";
import { routeForSegment, stripApiPrefix, firstSegment, isInternalOnly } from "./routes";
import { createServices } from "./services";
import { authenticate } from "./auth";
import { forwardRequest } from "./proxy";

function bodyCap(env: GatewayEnv, segment: string): number {
  const def = Number(env.DEFAULT_MAX_BODY_BYTES ?? "10485760");
  if (segment === "files") return Number(env.FILES_MAX_BODY_BYTES ?? "26214400");
  return def;
}

export async function gatewayRouteHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  const requestId = getRequestId(c);
  const pathname = new URL(c.req.url).pathname;

  const internalPath = stripApiPrefix(pathname);
  if (internalPath === null || internalPath === "/") {
    throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${pathname}`, 404);
  }
  const segment = firstSegment(internalPath);
  const route = routeForSegment(segment);
  if (!route) throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${pathname}`, 404);

  // internal-only sub-path -> 404 (double-defense; receiver also checks x-dub-internal)
  if (isInternalOnly(route, internalPath)) {
    throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${pathname}`, 404);
  }

  // HTTP only: reject WebSocket upgrades (RT is DO-direct, gateway non-transit)
  const upgrade = c.req.header("upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    throw gatewayError(GATEWAY_WEBSOCKET_UNSUPPORTED, "WebSocket upgrade is not supported", 400);
  }

  // body cap
  const cl = c.req.header("content-length");
  if (cl) {
    const size = Number(cl);
    const cap = bodyCap(c.env, segment);
    if (Number.isFinite(size) && size > cap) {
      throw new DubError(CommonErrorCodes.PAYLOAD_TOO_LARGE, `Request body exceeds ${cap} bytes`, { status: 413 });
    }
  }

  let userId: string | undefined;
  if (route.auth === "required") {
    const svc = createServices(c.env);
    const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
    userId = auth.userId;
  }

  const binding = bindingByName(c.env, route.binding);
  if (!binding) throw errors.upstreamUnavailable(route.binding);

  return forwardRequest(binding, internalPath, c.req.raw, {
    requestId,
    ...(userId ? { userId } : {}),
  });
}
