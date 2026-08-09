// CORS: credentialed allow-list. Only exact allowed origins get ACAO; unknown
// origins receive no ACAO (browser blocks). Preflight is answered here.
import type { MiddlewareHandler } from "hono";
import type { GatewayEnv } from "./env";

const DEFAULT_ORIGINS = ["https://app.developershub.jp", "http://localhost:5173", "http://localhost:3000"];

const ALLOW_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
const ALLOW_HEADERS = "authorization,content-type,x-dub-idempotency-key";
const MAX_AGE = "600";

export function allowedOrigins(env: GatewayEnv): string[] {
  const raw = env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function corsMiddleware(): MiddlewareHandler<{ Bindings: GatewayEnv }> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = origin ? allowedOrigins(c.env).includes(origin) : false;

    if (c.req.method === "OPTIONS") {
      const headers = new Headers();
      if (allowed && origin) {
        headers.set("access-control-allow-origin", origin);
        headers.set("access-control-allow-credentials", "true");
        headers.set("access-control-allow-methods", ALLOW_METHODS);
        headers.set("access-control-allow-headers", ALLOW_HEADERS);
        headers.set("access-control-max-age", MAX_AGE);
      }
      headers.append("vary", "Origin");
      return new Response(null, { status: 204, headers });
    }

    await next();

    if (allowed && origin) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-credentials", "true");
    }
    c.header("vary", "Origin", { append: true });
  };
}
