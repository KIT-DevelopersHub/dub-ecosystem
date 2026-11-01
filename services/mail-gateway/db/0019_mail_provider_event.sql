-- mail-gateway (送信プロバイダの配送イベント / Resend webhook) — one row per webhook delivery.
-- Mirror of services/mail-gateway/db/0019_mail_provider_event.sql (kept byte-identical;
-- infra is the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only; a new table only (no existing table is touched).
--
-- src/resend-webhook.ts records every alertable Resend event (email.bounced / complained /
-- delivery_delayed / failed / suppressed) after its Svix signature is verified, then raises
-- an admin alert. Timestamps are stamped app-side.
--   svix_id        : Svix delivery id = idempotency key (Resend reuses it on retry)
--   send_log_id    : mail_send_log.id matched via provider_message_id (NULL when unknown)
--   recipient_key  : lower-cased, sorted To addresses joined by "," (throttle key)
--   internal       : 1 when any recipient is on our own domain (always alerted)
--   alerted        : 1 when this event raised an admin alert (0 = throttled / not alertable)
CREATE TABLE IF NOT EXISTS mail_provider_event (
  svix_id             TEXT PRIMARY KEY,
  provider            TEXT NOT NULL DEFAULT 'resend',
  event_type          TEXT NOT NULL,                -- e.g. 'email.bounced'
  provider_message_id TEXT,                         -- Resend email_id
  send_log_id         TEXT,
  recipients_json     TEXT NOT NULL,                -- JSON string[]
  recipient_key       TEXT NOT NULL,
  internal            INTEGER NOT NULL DEFAULT 0,
  subject             TEXT,
  reason              TEXT,                         -- provider's raw reason / message
  occurred_at         TEXT,                         -- provider event time (ISO8601)
  alerted             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_provider_event_throttle ON mail_provider_event(recipient_key, alerted, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_provider_event_msg      ON mail_provider_event(provider_message_id);
