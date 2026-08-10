// mail-gateway service constants. Centralized so retention windows and the default
// mailbox stay in one place (they cross the app / inbound / cron boundaries).

export const SERVICE_NAME = "mail-gateway";

// Frozen system-default mailbox / From address for outbound (design §2/§6, α default).
// SendMailRequest carries no mailbox field in the frozen contract; this is the app
// default From when MAIL_FROM_ADDRESS is not set.
export const DEFAULT_MAILBOX = "info";
export const DEFAULT_FROM_ADDRESS = "info@developershub.jp";

// Retention windows (days) — purged by the daily scheduled handler (design §3).
export const SEND_LOG_RETENTION_DAYS = 30;
export const INBOUND_RETENTION_DAYS = 30;

// Validation limits.
export const SUBJECT_MAX = 998; // RFC 5322 line-length ceiling for a header value
export const MAX_RECIPIENTS = 100;

// Paging (common.CursorQuery: default 50 / max 200).
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

// Inbound raw read cap — we only need the snippet, never persist the body.
export const INBOUND_RAW_READ_BYTES = 64 * 1024;
export const SNIPPET_MAX = 200;

// The only headers a caller may influence on outbound (loop-prevention allowlist).
// Anything else in SendMailRequest.headers-shaped input is rejected.
export const OUTBOUND_HEADER_ALLOWLIST = ["x-dub-mail-loop", "auto-submitted"] as const;

// Managed outbound providers (frozen SendMailResponse.provider union). SES暫定 (ADR-001).
export const OUTBOUND_PROVIDERS = ["ses", "mailchannels", "resend"] as const;
export const DEFAULT_OUTBOUND_PROVIDER = "ses";

// Outbound send resilience (production hardening). A provider call is retried with
// exponential backoff + jitter ONLY when it fails with a transient (retryable) error
// (network/timeout/429/5xx). Deterministic failures (validation, unverified domain,
// 2xx-without-id) are never retried. Overridable via MAIL_SEND_MAX_ATTEMPTS /
// MAIL_SEND_TIMEOUT_MS so ops can tune without a redeploy of the code.
export const DEFAULT_SEND_MAX_ATTEMPTS = 3; // 1 initial attempt + up to 2 retries
export const DEFAULT_SEND_BASE_DELAY_MS = 200; // backoff base (200ms, 400ms, ...)
export const DEFAULT_SEND_TIMEOUT_MS = 15_000; // per-attempt upstream timeout (abort)
export const MAX_SEND_ATTEMPTS_CEIL = 6; // guardrail: never retry-storm a provider
