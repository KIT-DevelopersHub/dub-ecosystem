// Rate limiting. External contract = 429 + RateLimit-*/Retry-After headers only.
// The policy/state shape is internal. Default = per-isolate in-memory fixed window;
// when a shared KV namespace is bound (RATE_LIMIT_KV) the gateway upgrades to a
// cross-isolate KV fixed-window limiter — real limiting — without a contract change.
//
// Buckets (#856): a request carrying a session credential is counted per SESSION
// (hash of the bearer/cookie token), so members behind one venue Wi-Fi IP no longer
// share a single budget. Every credentialed request is ALSO counted against a much
// higher per-IP ceiling, so minting random tokens cannot buy unlimited budget. A request
// with no credential (login, public forms, LP beacons) falls back to a per-IP bucket.
// The limiter runs before the policy gate on purpose (429-before-401, cheap refusal),
// so the session key is the unverified token — an invalid one still 401s at the gate.
import type { MiddlewareHandler } from "hono";
import type { KVNamespace } from "@cloudflare/workers-types";
import { toResponse, errors } from "@dub/errors";
import { HDR_REQUEST_ID } from "@dub/observability";
import type { GatewayEnv } from "./env";
import type { GatewayVariables } from "./context";
import { getRequestId } from "./context";
import { extractToken } from "./auth";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetEpochSec: number;
}

export interface RateLimiter {
  /** `limit` overrides the limiter's default budget for this bucket (tiered policy). */
  check(key: string, limit?: number): Promise<RateLimitResult>;
}

export interface FixedWindowOptions {
  limit?: number; // requests per window (default 100)
  windowMs?: number; // window length (default 60_000)
  now?: () => number;
}

// Per-session keys make the bucket map grow with distinct tokens; drop finished windows
// once it gets large so a long-lived isolate cannot accumulate them without bound.
const MAX_MEMORY_BUCKETS = 10_000;
function pruneExpired(buckets: Map<string, { windowStart: number }>, t: number, windowMs: number): void {
  for (const [k, b] of buckets) if (t - b.windowStart >= windowMs) buckets.delete(k);
}

/** In-memory fixed-window limiter (per isolate). Deterministic clock injectable for tests. */
export function createInMemoryRateLimiter(opts: FixedWindowOptions = {}): RateLimiter {
  const defaultLimit = opts.limit ?? 100;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; windowStart: number }>();

  return {
    async check(key: string, limitOverride?: number): Promise<RateLimitResult> {
      const limit = limitOverride ?? defaultLimit;
      const t = now();
      if (buckets.size > MAX_MEMORY_BUCKETS) pruneExpired(buckets, t, windowMs);
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
  const defaultLimit = opts.limit ?? 100;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const prefix = opts.keyPrefix ?? "gw:rl:";

  return {
    async check(key: string, limitOverride?: number): Promise<RateLimitResult> {
      const limit = limitOverride ?? defaultLimit;
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

/** Positive finite number from a string var, else undefined. */
function positive(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const DEFAULT_WINDOW_MS = 60_000;

/** Window length from RATE_LIMIT_WINDOW_MS (default 60_000). */
export function rateLimitWindowFromEnv(env: GatewayEnv): number {
  return positive(env.RATE_LIMIT_WINDOW_MS) ?? DEFAULT_WINDOW_MS;
}

/**
 * Budgets per window. Sizing (#856): one screen load fans out to ~9-17 API calls
 * (mail 17, members 9, LP admin 11), so 600/min/session ≈ 35+ screen loads a minute —
 * normal navigation never hits it. The per-IP ceiling bounds the WHOLE shared IP
 * (≈ 30+ members at a venue each at 200/min) and caps token-spraying from one source.
 * Anonymous traffic (login / public forms / LP beacons) stays per IP.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  perSession: 600,
  perIpAnonymous: 300,
  perIpCeiling: 6000,
};

export interface RateLimitPolicy {
  /** requests/window per session credential (RATE_LIMIT_USER_MAX) */
  perSession: number;
  /** requests/window per IP for requests with no credential (RATE_LIMIT_IP_MAX; legacy RATE_LIMIT_MAX) */
  perIpAnonymous: number;
  /** requests/window per IP across ALL credentialed requests from it (RATE_LIMIT_IP_CEILING) */
  perIpCeiling: number;
}

/** Policy from env vars, each optional; invalid/absent values fall back to the defaults. */
export function rateLimitPolicyFromEnv(env: GatewayEnv): RateLimitPolicy {
  const d = DEFAULT_RATE_LIMIT_POLICY;
  return {
    perSession: positive(env.RATE_LIMIT_USER_MAX) ?? d.perSession,
    perIpAnonymous: positive(env.RATE_LIMIT_IP_MAX) ?? positive(env.RATE_LIMIT_MAX) ?? d.perIpAnonymous,
    perIpCeiling: positive(env.RATE_LIMIT_IP_CEILING) ?? d.perIpCeiling,
  };
}

/**
 * Build the shared KV limiter from the environment, or undefined when no KV namespace
 * is bound (the caller then falls back to the in-memory limiter). Budgets come from
 * rateLimitPolicyFromEnv per bucket; the window from RATE_LIMIT_WINDOW_MS.
 */
export function rateLimiterFromEnv(env: GatewayEnv): RateLimiter | undefined {
  if (!env.RATE_LIMIT_KV) return undefined;
  return createKvRateLimiter(env.RATE_LIMIT_KV, { windowMs: rateLimitWindowFromEnv(env) });
}

/** Client key: CF edge IP, falling back to a stable literal (shared bucket). */
export function clientKey(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for") ?? "unknown";
}

/** Stable, non-reversible bucket id for a session credential. The raw token never
 *  becomes a map/KV key (KV keys are listable). */
export async function sessionKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let hex = "";
  for (const b of new Uint8Array(digest).slice(0, 16)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export interface RateLimitMiddlewareOptions {
  /** When true, prefer a shared KV limiter derived from env; else always use `fallback`. */
  preferEnv?: boolean;
  /** Fixed policy (tests). Defaults to rateLimitPolicyFromEnv(c.env) per request. */
  policy?: RateLimitPolicy;
}

/** `fallback` is a limiter, or a resolver called with c.env (lazy per-isolate limiter). */
export function rateLimitMiddleware(
  fallback: RateLimiter | ((env: GatewayEnv) => RateLimiter),
  opts: RateLimitMiddlewareOptions = {},
): MiddlewareHandler<{ Bindings: GatewayEnv; Variables: GatewayVariables }> {
  return async (c, next) => {
    // Resolve per request: the KV binding is only available on c.env. The in-memory
    // fallback stays module-scoped so its per-isolate counters persist across requests.
    const limiter =
      (opts.preferEnv ? rateLimiterFromEnv(c.env) : undefined) ??
      (typeof fallback === "function" ? fallback(c.env) : fallback);
    const policy = opts.policy ?? rateLimitPolicyFromEnv(c.env);
    const ip = clientKey(c.req.raw.headers);
    const token = extractToken(c.req.raw.headers);

    let r: RateLimitResult;
    if (token) {
      // Session bucket first; only an allowed request is charged to the IP ceiling.
      r = await limiter.check(`s:${await sessionKey(token)}`, policy.perSession);
      if (r.allowed) {
        const ceiling = await limiter.check(`ipc:${ip}`, policy.perIpCeiling);
        if (!ceiling.allowed) r = ceiling;
      }
    } else {
      r = await limiter.check(`ip:${ip}`, policy.perIpAnonymous);
    }

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
