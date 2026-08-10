// Rate-limit visibility. The provider returning HTTP 429 is a distinct condition from a
// generic upstream fault (502): it is a QUOTA signal an operator must see (Resend free
// tier = 100/day, 3000/month), not just a transient blip. So we give it its own error
// code (MAIL_RATE_LIMITED, 429) carrying the provider's Retry-After, and expose a
// derived "recently rate-limited" status from the send-log so the admin UI can surface it.
import { DubError, type RateLimitDetails } from "@dub/errors";

/** Service-specific error code (open half of the code space). 429, retryable. */
export const MAIL_RATE_LIMITED = "MAIL_RATE_LIMITED";

/** How long after the last 429 we still report "rate-limited" when the provider gave no
 *  Retry-After. Clamp bounds for the MAIL_RATE_LIMIT_COOLDOWN_SEC override. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_SEC = 60;
const COOLDOWN_MIN_SEC = 5;
const COOLDOWN_MAX_SEC = 24 * 60 * 60; // 1 day

/** Retry-After clamp: a delta-seconds value is bounded so a hostile/garbled header can
 *  never make the UI promise a recovery years out (or in the past). */
const RETRY_AFTER_MAX_SEC = 24 * 60 * 60;

/**
 * Parse an HTTP `Retry-After` response header into whole seconds. Accepts the two RFC 7231
 * forms — a non-negative delta-seconds integer, or an HTTP-date — and returns undefined for
 * an absent/garbled value. The body must already have been consumed; we only read a header.
 */
export function parseRetryAfter(res: Response, nowMs: number = Date.now()): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (!Number.isFinite(secs)) return undefined;
    return Math.min(Math.max(0, Math.floor(secs)), RETRY_AFTER_MAX_SEC);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = Math.ceil((dateMs - nowMs) / 1000);
  return Math.min(Math.max(0, delta), RETRY_AFTER_MAX_SEC);
}

/**
 * Build the MAIL_RATE_LIMITED error for a provider 429. Stays `retryable: true` (the
 * message was not accepted; the bounded send-retry may still clear it), and carries the
 * parsed Retry-After as `details.retryAfterSec` so the immediate caller and the wire body
 * get an accurate recovery hint. `detail` is the provider's secret-free message, if any.
 */
export function rateLimitError(providerLabel: string, res: Response, detail: string | null, nowMs: number = Date.now()): DubError {
  const retryAfterSec = parseRetryAfter(res, nowMs);
  const details: RateLimitDetails | undefined = retryAfterSec !== undefined ? { retryAfterSec } : undefined;
  return new DubError(
    MAIL_RATE_LIMITED,
    `${providerLabel} rate-limited the request (429)${detail ? `: ${detail}` : ""}`,
    { status: 429, retryable: true, ...(details ? { details } : {}) },
  );
}

/** Read + clamp the MAIL_RATE_LIMIT_COOLDOWN_SEC var (non-secret [vars]); default 60. */
export function parseCooldownSec(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RATE_LIMIT_COOLDOWN_SEC;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < COOLDOWN_MIN_SEC || n > COOLDOWN_MAX_SEC) return DEFAULT_RATE_LIMIT_COOLDOWN_SEC;
  return n;
}

/** The rate-limit view the /internal/status endpoint returns (secret-free). */
export interface MailRateLimitStatus {
  /** True when the most recent send failure was a 429 still inside the cooldown window. */
  active: boolean;
  /** The error code that put us here (MAIL_RATE_LIMITED), when active. */
  code?: string;
  /** ISO8601 of the observed 429 (the send-log row's updated_at), when active. */
  since?: string;
  /** ISO8601 estimate of when we expect to be clear again, when active. */
  recoversAt?: string;
  /** The cooldown window used for the derivation (seconds). Always present. */
  cooldownSec: number;
}

/**
 * Derive the current rate-limit status from the most recent FAILED send-log row. Pure so it
 * is trivially unit-tested. Active iff that failure was a MAIL_RATE_LIMITED and its
 * timestamp is within `cooldownSec` of now; otherwise clear (including when the latest
 * failure was some other code, i.e. we recovered enough to fail differently).
 */
export function deriveRateLimitStatus(
  latest: { error_code: string | null; updated_at: string } | null,
  nowMs: number,
  cooldownSec: number,
): MailRateLimitStatus {
  const clear: MailRateLimitStatus = { active: false, cooldownSec };
  if (!latest || latest.error_code !== MAIL_RATE_LIMITED) return clear;
  const observedMs = Date.parse(latest.updated_at);
  if (Number.isNaN(observedMs)) return clear;
  const recoversMs = observedMs + cooldownSec * 1000;
  if (recoversMs <= nowMs) return clear;
  return {
    active: true,
    code: MAIL_RATE_LIMITED,
    since: latest.updated_at,
    recoversAt: new Date(recoversMs).toISOString(),
    cooldownSec,
  };
}
