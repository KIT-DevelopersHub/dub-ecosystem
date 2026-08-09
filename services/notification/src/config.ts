// notification service constants. Centralized so retention windows and delivery
// retry budget stay in one place (they cross the app / queue / cron boundaries).

export const SERVICE_NAME = "notification";

// Frozen system-default mailbox for outbound email (design §2). SendMailRequest
// carries no mailbox field in the frozen contract, so this rides as an app constant
// only (used for the EmailAdapter idempotency namespace / future From selection).
export const DEFAULT_MAILBOX = "info";

// Per-(user,channel) delivery attempt budget before the delivery is marked failed
// and a delivery-failed audit record is emitted (design test #13).
export const MAX_DELIVERY_ATTEMPTS = 3;

// Retention windows (days) — purged by the daily scheduled handler (design §3).
export const INBOX_RETENTION_DAYS = 90;
export const DELIVERIES_RETENTION_DAYS = 30;
export const PROCESSED_EVENTS_RETENTION_DAYS = 7;

// Validation limits.
export const TITLE_MIN = 1;
export const TITLE_MAX = 200;
export const MAX_DIRECT_RECIPIENTS = 1000;

// Paging (common.CursorQuery: default 50 / max 200).
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

// The 4 frozen channels (theme4). slack is intentionally excluded.
export const CHANNELS = ["in_app", "email", "chat", "push"] as const;
