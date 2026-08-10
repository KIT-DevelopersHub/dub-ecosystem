// Wire shape for the mail-gateway rate-limit status the admin shell surfaces.
//
// The mail-gateway exposes this as an internal-only `GET /internal/status`
// (services/mail-gateway/src/app.ts); the admin SPA reaches it through the
// gateway boundary `GET /api/v1/mail/status` like every other FE7 call (design
// §2-4). We mirror the secret-free `rateLimit` view here rather than importing a
// service type — FE7 is a pure frontend and must not depend on a service package.
export interface MailRateLimitStatus {
  /** True when the most recent send failure was a 429 still inside the cooldown window. */
  active: boolean;
  /** The error code that put us here (MAIL_RATE_LIMITED), when active. */
  code?: string;
  /** ISO8601 of the observed 429, when active. */
  since?: string;
  /** ISO8601 estimate of when we expect to be clear again, when active. */
  recoversAt?: string;
  /** The cooldown window used for the derivation (seconds). Always present. */
  cooldownSec: number;
}

/** The `/api/v1/mail/status` response body (secret-free). */
export interface MailStatusResponse {
  service: string;
  provider: string;
  rateLimit: MailRateLimitStatus;
}

/** Not-limited default. Used as the fail-safe view while loading or on fetch error. */
export const CLEAR_MAIL_RATE_LIMIT: MailRateLimitStatus = { active: false, cooldownSec: 60 };
