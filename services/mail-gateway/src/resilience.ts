// Env-derived send-resilience config. Kept in one place so the providers (per-attempt
// timeout) and the send core (retry budget) read the same tuned values, and an operator
// can adjust them via [vars] without a code change. All inputs are optional strings with
// clamped, sane defaults — a malformed value falls back rather than breaking a send.
import {
  DEFAULT_SEND_BASE_DELAY_MS,
  DEFAULT_SEND_MAX_ATTEMPTS,
  DEFAULT_SEND_TIMEOUT_MS,
  MAX_SEND_ATTEMPTS_CEIL,
} from "./config";
import type { Env } from "./env";
import type { RetryOptions } from "./retry";

function parseIntInRange(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return def;
  return n;
}

/** Per-attempt upstream timeout (ms), 1000..120000, default 15000. */
export function parseTimeoutMs(env: Env): number {
  return parseIntInRange(env.MAIL_SEND_TIMEOUT_MS, DEFAULT_SEND_TIMEOUT_MS, 1_000, 120_000);
}

/** Total send attempts, 1..MAX_SEND_ATTEMPTS_CEIL, default 3 (1 try + 2 retries). */
export function parseMaxAttempts(env: Env): number {
  return parseIntInRange(env.MAIL_SEND_MAX_ATTEMPTS, DEFAULT_SEND_MAX_ATTEMPTS, 1, MAX_SEND_ATTEMPTS_CEIL);
}

/** The retry budget the send core hands to withRetry(). */
export function sendRetryOptions(env: Env): Pick<RetryOptions, "maxAttempts" | "baseDelayMs"> {
  return { maxAttempts: parseMaxAttempts(env), baseDelayMs: DEFAULT_SEND_BASE_DELAY_MS };
}
