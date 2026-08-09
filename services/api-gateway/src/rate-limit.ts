// Rate limiting. External contract = 429 + RateLimit-*/Retry-After headers only.
// The policy/state shape is internal. P0 default = in-memory fixed window; R1 will
// swap in the CF native Rate Limiting binding (RATE_LIMITER) without contract change.
import type { MiddlewareHandler } from "hono";
import { toResponse, errors } from "@dub/errors";
import { HDR_REQUEST_ID } from "@dub/observability";
import type { GatewayVariables } from "./context";
import { getRequestId } from "./context";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetEpochSec: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

export interface FixedWindowOptions {
  limit?: number; // requests per window (default 100)
  windowMs?: number; // window length (default 60_000)
  now?: () => number;
}

/** In-memory fixed-window limiter (per isolate). Deterministic clock injectable for tests. */
export function createInMemoryRateLimiter(opts: FixedWindowOptions = {}): RateLimiter {
  const limit = opts.limit ?? 100;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; windowStart: number }>();

  return {
    async check(key: string): Promise<RateLimitResult> {
      const t = now();
      let b = buckets.get(key);
      if (!b || t - b.windowStart >= windowMs) {
        b = { count: 0, windowStart: t };
        buckets.set(key, b);
      }
      b.count++;
      const resetMs = b.windowStart + windowMs;
      const remaining = Math.max(0, limit - b.count);
      return {
        allowed: b.count <= limit,
        limit,
        remaining,
        retryAfterSec: Math.max(1, Math.ceil((resetMs - t) / 1000)),
        resetEpochSec: Math.ceil(resetMs / 1000),
      };
    },
  };
}

/** Client key: CF edge IP, falling back to a stable literal (shared bucket). */
export function clientKey(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for") ?? "unknown";
}

export function rateLimitMiddleware(limiter: RateLimiter): MiddlewareHandler<{ Variables: GatewayVariables }> {
  return async (c, next) => {
    const key = clientKey(c.req.raw.headers);
    const r = await limiter.check(key);
    if (!r.allowed) {
      const requestId = getRequestId(c);
      const res = toResponse(errors.rateLimited(r.retryAfterSec), { requestId });
      res.headers.set("ratelimit-limit", String(r.limit));
      res.headers.set("ratelimit-remaining", "0");
      res.headers.set("ratelimit-reset", String(r.resetEpochSec));
      res.headers.set(HDR_REQUEST_ID, requestId);
      return res;
    }
    c.header("ratelimit-limit", String(r.limit));
    c.header("ratelimit-remaining", String(r.remaining));
    c.header("ratelimit-reset", String(r.resetEpochSec));
    await next();
  };
}
