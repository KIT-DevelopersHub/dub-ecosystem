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

// ---- in-app feedback (widget -> admin) ----
// Closed category vocabulary (mirrors notification.FeedbackCategory).
export const FEEDBACK_CATEGORIES = ["bug", "idea", "question", "other"] as const;
export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_PAGE_URL_MAX = 2048;
export const FEEDBACK_PAGE_NAME_MAX = 200;
// Permission gate for the admin read surface (GET /feedback, PATCH …/read).
export const FEEDBACK_ADMIN_PERMISSION = "notif:admin" as const;
// Best-effort admin notification recipient. Deliverability depends on domain
// verification; a send failure never blocks the feedback save.
export const FEEDBACK_ADMIN_EMAIL = "admin@developershub.jp";
// Excerpt length for the notification subject "フィードバック: <抜粋>".
export const FEEDBACK_EXCERPT_LEN = 60;
