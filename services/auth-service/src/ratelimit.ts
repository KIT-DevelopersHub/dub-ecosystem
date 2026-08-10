// Soft brute-force guard for password login. Fixed-window failure counters in KV,
// keyed by IP and by email; TTL-bounded so windows self-expire. Not a hard security
// control (KV counters are eventually-consistent) — it exists to blunt credential-
// stuffing on the free tier. Counters are bumped only on a FAILED attempt and the
// email counter is reset on success, so legitimate logins are never throttled.
export interface RateLimiter {
  /** Read the current failure count for `key` (0 if none / expired). */
  peek(key: string): Promise<number>;
  /** Increment the failure counter for `key` (fresh window TTL). */
  hit(key: string, windowSec: number): Promise<number>;
  /** Clear the counter (called after a successful login). */
  reset(key: string): Promise<void>;
}

const RL_PREFIX = "pwrl:";

export interface KvSeam {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
}

function parseCount(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class KvRateLimiter implements RateLimiter {
  constructor(private readonly kv: KvSeam) {}
  async peek(key: string): Promise<number> {
    return parseCount(await this.kv.get(RL_PREFIX + key));
  }
  async hit(key: string, windowSec: number): Promise<number> {
    const k = RL_PREFIX + key;
    const count = parseCount(await this.kv.get(k)) + 1;
    await this.kv.put(k, String(count), windowSec);
    return count;
  }
  async reset(key: string): Promise<void> {
    await this.kv.delete(RL_PREFIX + key);
  }
}
