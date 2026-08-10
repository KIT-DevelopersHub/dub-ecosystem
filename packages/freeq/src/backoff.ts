// Exponential backoff for outbox redelivery. Pure + deterministic (no jitter) so
// the drain state machine is unit-testable; delay = base * 2^(attempts-1), capped.
export interface BackoffOptions {
  baseDelayMs?: number; // delay after the 1st failed attempt (default 1s)
  maxDelayMs?: number; // ceiling (default 1h)
}

const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 60 * 60 * 1_000;

/** Delay (ms) before the next attempt, given how many attempts have now failed (>=1). */
export function backoffMs(attempts: number, opts: BackoffOptions = {}): number {
  const base = opts.baseDelayMs ?? DEFAULT_BASE_MS;
  const max = opts.maxDelayMs ?? DEFAULT_MAX_MS;
  const n = Math.max(1, Math.floor(attempts));
  // 2^(n-1) can overflow for large n; clamp the exponent so Math.min still caps it.
  const factor = n - 1 >= 40 ? Number.POSITIVE_INFINITY : 2 ** (n - 1);
  return Math.min(base * factor, max);
}
