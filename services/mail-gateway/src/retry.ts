// Bounded retry with exponential backoff + full jitter for the outbound provider call.
// Production hardening (Go-Live): a transient provider hiccup (network reset, request
// timeout, 429, 5xx) should not surface as a hard send failure on the first blip. Only
// errors explicitly flagged retryable are retried — deterministic failures (validation,
// unverified domain, 2xx-without-id, auth) fail fast. The provider has NOT accepted the
// message on a retryable error (pre-acceptance transport/throttle failure), so retrying
// does not double-send; a retryable 5xx carries a small, documented double-send risk that
// the idempotent send-log + our stamped Message-Id keep bounded (README §Known limits).
import { isDubError } from "@dub/errors";

export interface RetryOptions {
  maxAttempts: number; // total attempts (>=1). 1 => no retry.
  baseDelayMs: number; // backoff base; attempt n waits ~ base * 2^(n-1), jittered.
  /** Injectable for tests (no real timers). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic jitter in tests. Defaults to Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A thrown value is retryable iff it is a DubError with retryable === true. */
export function isRetryable(err: unknown): boolean {
  return isDubError(err) && err.retryable;
}

/**
 * Run `fn`, retrying only retryable errors up to `maxAttempts` total tries. Backoff is
 * exponential with full jitter (delay ∈ [base·2^(n-1)/2, base·2^(n-1)]) to avoid a
 * thundering-herd retry storm against the provider. The last error is re-thrown intact
 * (same DubError) so the send core records the right code / status.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const ceil = opts.baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.floor(ceil * (0.5 + random() * 0.5));
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable (loop returns or throws), kept for type-safety.
}
