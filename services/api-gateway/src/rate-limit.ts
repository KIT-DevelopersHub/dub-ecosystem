// Rate limiting. External contract = 429 + RateLimit-*/Retry-After headers only.
// The policy/state shape is internal. Default = per-isolate in-memory fixed window;
// when a shared KV namespace is bound (RATE_LIMIT_KV) the gateway upgrades to a
// cross-isolate KV fixed-window limiter — real limiting — without a contract change.
import type { MiddlewareHandler } from "hono";
import type { KVNamespace } from "@cloudflare/workers-types";
import { toResponse, errors } from "@dub/errors";
import { HDR_REQUEST_ID } from "@dub/observability";
import type { GatewayEnv } from "./env";
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

/**
 * Cross-isolate fixed-window limiter backed by a KV namespace. Read-modify-write is
 * acceptable for a *soft* per-IP limit (exactness is not required); unlike the
 * in-memory limiter its counter is shared across every isolate, so the window budget
 * is enforced fleet-wide. Emits the identical wire signals as the in-memory variant.
 */
export function createKvRateLimiter(kv: KVNamespace, opts: FixedWindowOptions & { keyPrefix?: string } = {}): RateLimiter {
  const limit = opts.limit ?? 100;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const prefix = opts.keyPrefix ?? "gw:rl:";

  return {
    async check(key: string): Promise<RateLimitResult> {
      const t = now();
      const windowStart = Math.floor(t / windowMs) * windowMs; // calendar-aligned window
      const resetMs = windowStart + windowMs;
      const kvKey = `${prefix}${key}:${windowStart}`;

      const raw = await kv.get(kvKey);
      const prior = raw ? Number(raw) : 0;
      const count = (Number.isFinite(prior) ? prior : 0) + 1;

      // TTL = remainder of the window + a small buffer, floored at KV's 60s minimum.
      const ttlSec = Math.max(60, Math.ceil((resetMs - t) / 1000) + 5);
      await kv.put(kvKey, String(count), { expirationTtl: ttlSec });

      const remaining = Math.max(0, limit - count);
      return {
        allowed: count <= limit,
        limit,
        remaining,
        retryAfterSec: Math.max(1, Math.ceil((resetMs - t) / 1000)),
        resetEpochSec: Math.ceil(resetMs / 1000),
      };
    },
  };
}

/**
 * Build the shared KV limiter from the environment, or undefined when no KV namespace
 * is bound (the caller then falls back to the in-memory limiter). Policy is env-tunable
 * (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS) without a contract change.
 */
export function rateLimiterFromEnv(env: GatewayEnv): RateLimiter | undefined {
  if (!env.RATE_LIMIT_KV) return undefined;
  const limit = Number(env.RATE_LIMIT_MAX);
  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS);
  return createKvRateLimiter(env.RATE_LIMIT_KV, {
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(Number.isFinite(windowMs) && windowMs > 0 ? { windowMs } : {}),
  });
}

/** Client key: CF edge IP, falling back to a stable literal (shared bucket). */
export function clientKey(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for") ?? "unknown";
}

export interface RateLimitMiddlewareOptions {
  /** When true, prefer a shared KV limiter derived from env; else always use `fallback`. */
  preferEnv?: boolean;
}

export function rateLimitMiddleware(
  fallback: RateLimiter,
  opts: RateLimitMiddlewareOptions = {},
): MiddlewareHandler<{ Bindings: GatewayEnv; Variables: GatewayVariables }> {
  return async (c, next) => {
    // Resolve per request: the KV binding is only available on c.env. The in-memory
    // fallback stays module-scoped so its per-isolate counters persist across requests.
    const limiter = (opts.preferEnv ? rateLimiterFromEnv(c.env) : undefined) ?? fallback;
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
