// Catch-all handler for /api/v1/* transparent routing: resolve rule -> guards
// (WS reject, body cap, internal-only 404) -> optional entry verify -> forward.
//
// AUTHZ: none, deliberately. The policy gate lets a purely proxied request through because
// the service that owns the route owns the decision (see policy-table.ts). What happens here
// is authentication plus transport: verify the session, stamp the trusted x-dub-user-id,
// strip anything spoofed (proxy.ts), forward.
import type { Context } from "hono";
import { errors, DubError, CommonErrorCodes } from "@dub/errors";
import type { GatewayEnv } from "./env";
import { bindingByName } from "./env";
import type { GatewayVariables } from "./context";
import { getRequestId, gatewayError, GATEWAY_ROUTE_NOT_FOUND, GATEWAY_WEBSOCKET_UNSUPPORTED } from "./context";
import { routeForSegment, stripApiPrefix, firstSegment, isInternalOnly, GATEWAY_OWNED_SEGMENTS } from "./routes";
import { authenticateOnce } from "./policy";
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
  // Gateway-owned segments must never be proxied. Reaching here with one means a path under
  // /me, /bff, /public or /admin matched no concrete gateway route — a 404, never a forward.
  // ROUTES happens to contain no owned segment today so this is already the outcome; the
  // explicit check makes GATEWAY_OWNED_SEGMENTS the enforced source of truth instead of a
  // coincidence, so adding `{ segment: "admin", ... }` to ROUTES cannot silently start
  // proxying the admin surface. test/policy-table.test.ts pins the invariant.
  if (GATEWAY_OWNED_SEGMENTS.has(segment)) {
    throw gatewayError(GATEWAY_ROUTE_NOT_FOUND, `No route for ${pathname}`, 404);
  }
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
    userId = (await authenticateOnce(c)).userId;
  }

  const binding = bindingByName(c.env, route.binding);
  if (!binding) throw errors.upstreamUnavailable(route.binding);

  return forwardRequest(binding, internalPath, c.req.raw, {
    requestId,
    ...(userId ? { userId } : {}),
  });
}
