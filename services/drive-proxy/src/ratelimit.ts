// Self-imposed soft rate limit, below Google's real quota (§2-2 "single source of
// rate control"). P0 uses a KV fixed-window counter (read-modify-write is
// acceptable for a *soft* limit; exactness is not required — §8-2 old#8).
import type { KVNamespace } from "@cloudflare/workers-types";
import { errors } from "@dub/errors";
import type { QuotaStatusResponse } from "./types";

export interface RateLimiter {
  /** Count one Google call; throw RATE_LIMITED when the soft limit is reached. */
  acquire(): Promise<void>;
  status(): Promise<QuotaStatusResponse>;
}

const RATE_PREFIX = "drive:ratelimit:";

export function createKvRateLimiter(
  kv: KVNamespace,
  cfg: { windowSeconds: number; softLimit: number },
  now: () => number = Date.now,
): RateLimiter {
  const windowKey = (): string => {
    const w = Math.floor(now() / 1000 / cfg.windowSeconds);
    return `${RATE_PREFIX}${w}`;
  };
  async function read(): Promise<number> {
    const raw = await kv.get(windowKey());
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  }
  return {
    async acquire(): Promise<void> {
      const used = await read();
      if (used >= cfg.softLimit) throw errors.rateLimited(cfg.windowSeconds);
      await kv.put(windowKey(), String(used + 1), { expirationTtl: Math.max(60, cfg.windowSeconds * 2) });
    },
    async status(): Promise<QuotaStatusResponse> {
      const used = await read();
      return {
        windowSeconds: cfg.windowSeconds,
        usedRequests: used,
        softLimit: cfg.softLimit,
        throttling: used >= cfg.softLimit,
      };
    },
  };
}
