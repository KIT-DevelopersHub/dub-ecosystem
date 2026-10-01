// Per-request context: correlation-id minting/inheritance + typed Hono variables.
import type { Context, MiddlewareHandler } from "hono";
import { DubError, toResponse } from "@dub/errors";
import { HDR_REQUEST_ID } from "@dub/observability";
import { newRequestId } from "@dub/http";

// gateway-specific error codes (common codes come from @dub/errors).
export const GATEWAY_ROUTE_NOT_FOUND = "GATEWAY_ROUTE_NOT_FOUND"; // 404
export const GATEWAY_TURNSTILE_FAILED = "GATEWAY_TURNSTILE_FAILED"; // 403
export const GATEWAY_WEBSOCKET_UNSUPPORTED = "GATEWAY_WEBSOCKET_UNSUPPORTED"; // 400

export interface GatewayVariables {
  requestId: string;
  /** Acting user, published by the policy gate on every route it authenticates. */
  userId?: string;
  /**
   * The verified session, set by the gate's actor resolver (policy.ts) and read by
   * gateway-owned handlers. Absent on PUBLIC routes and on the proxy path until
   * `authenticateOnce` runs, so one request never verifies twice.
   */
  authed?: import("./auth").Authenticated;
}

/** Mint (or inherit) x-dub-request-id and expose it on the response. Runs first. */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const inherited = c.req.header(HDR_REQUEST_ID);
    const requestId = inherited && inherited.length > 0 ? inherited : newRequestId();
    c.set("requestId", requestId);
    await next();
    c.header(HDR_REQUEST_ID, requestId);
  };
}

export function getRequestId(c: Context): string {
  return (c.get("requestId") as string | undefined) ?? newRequestId();
}

/** onError: format any throw into the wire ErrorResponse, always carrying requestId. */
export function gatewayErrorHandler(err: unknown, c: Context): Response {
  const requestId = getRequestId(c);
  const res = toResponse(err, { requestId });
  res.headers.set(HDR_REQUEST_ID, requestId);
  return res;
}

/** Convenience thrower for gateway-owned 4xx codes. */
export function gatewayError(code: string, message: string, status: number, details?: unknown): DubError {
  return new DubError(code, message, details !== undefined ? { status, details } : { status });
}
