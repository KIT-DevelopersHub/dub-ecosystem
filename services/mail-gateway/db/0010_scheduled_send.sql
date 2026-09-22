-- mail-gateway (#15) — scheduled send (予約送信 / 予約投稿) slice. Additive, forward-only.
-- Mirror of infra/d1/migrations/mail/0010_scheduled_send.sql (kept byte-identical; infra
-- is the 正本 / runner, this copy backs the in-memory test schema in test/d1.ts).
--
-- A compose parked to go out at a future time. The full payload is stored here with
-- status='scheduled' and a due time (scheduled_at). A free-tier drain (the mail-gateway
-- cron; see src/scheduled-send.ts) claims due rows (status='scheduled' AND scheduled_at
-- <= now) and hands each to the SAME send core as an immediate send, so 二重送信ゼロ,
-- the Sent folder and the archive-CC all hold. Cancel = status flips to 'canceled';
-- delivery = 'sent' (sent_message_id recorded); a drain that exhausts retries = 'failed'.
--   owner_user_id : the composer (Scheduled-folder scope); NULL for a system schedule.
--   from_address  : envelope From when already resolved; NULL => resolve at send time.
--   in_reply_to   : parent RFC Message-Id when the scheduled send is a reply.
--   attempts      : drain attempts so far (bounded before the row goes 'failed').
-- Timestamps stamped app-side (nowIso); no DDL DEFAULT on them (theme3 D2). Attachments
-- are NOT stored on a scheduled send in this slice.
CREATE TABLE IF NOT EXISTS mail_scheduled (
  id              TEXT PRIMARY KEY,               -- prefix-ULID (newId("mailsch"))
  owner_user_id   TEXT,                           -- composer (scope); NULL = system schedule
  to_json         TEXT NOT NULL,                  -- JSON MailAddress[]
  cc_json         TEXT,                           -- JSON MailAddress[] (NULL/'[]' when none)
  subject         TEXT NOT NULL,
  text_body       TEXT NOT NULL,
  html_body       TEXT,                           -- HTML part when present; sanitized before render
  in_reply_to     TEXT,                           -- parent RFC Message-Id (reply); NULL otherwise
  from_address    TEXT,                           -- envelope From when known; NULL => resolve at send
  scheduled_at    TEXT NOT NULL,                  -- ISO8601 due time (row due when this <= now)
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','sent','canceled','failed')),
  sent_message_id TEXT,                           -- RFC Message-Id once delivered
  error_code      TEXT,                           -- @dub/errors code when 'failed'
  attempts        INTEGER NOT NULL DEFAULT 0,     -- drain attempts (bounded)
  snippet         TEXT,                           -- first ~140 chars of text_body (list preview)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
-- Drain claim: (status, scheduled_at) covers the "due scheduled rows, oldest first" scan.
CREATE INDEX IF NOT EXISTS idx_mail_scheduled_due   ON mail_scheduled(status, scheduled_at);
-- Owner-scoped Scheduled-folder list, newest schedule first.
CREATE INDEX IF NOT EXISTS idx_mail_scheduled_owner ON mail_scheduled(owner_user_id, scheduled_at);
