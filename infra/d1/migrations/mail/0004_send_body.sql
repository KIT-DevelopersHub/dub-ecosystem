-- mail-gateway (#15) — sent-log body slice (統合波 next slice). Additive, forward-only.
-- Mirror of infra/d1/migrations/mail/0004_send_body.sql (kept byte-identical; infra #28
-- is the 正本 / runner, this copy backs the in-memory test schema in test/d1.ts).
-- Persists the outbound body + recipients on mail_send_log so a "Sent" folder can list
-- and open what was sent (GET /sent, GET /sent/:id). Until now the send-log stored only
-- to_json/subject/thread_id (no body), so sent mail was invisible to the UI.
--   text_body    : plain-text body as submitted (mirrors mail_inbound.body_text).
--   html_body    : HTML part when present (NULL otherwise); sanitized before render.
--   cc_json      : JSON MailAddress[] of Cc recipients (NULL / '[]' when none).
--   snippet      : first ~140 chars of text_body, single line (list-row preview).
--   from_address : envelope From used for the send (for the Sent-row header).
-- All nullable: existing rows backfill to NULL (empty body, no cc) and simply render
-- with an empty preview — no data loss, no rewrite. No timestamp DEFAULT (theme3 D2);
-- created_at/updated_at already stamped app-side. ADD COLUMN only (D1 has no
-- "ADD COLUMN IF NOT EXISTS"), matching the 0002 style.
ALTER TABLE mail_send_log ADD COLUMN text_body TEXT;
ALTER TABLE mail_send_log ADD COLUMN html_body TEXT;
ALTER TABLE mail_send_log ADD COLUMN cc_json TEXT;
ALTER TABLE mail_send_log ADD COLUMN snippet TEXT;
ALTER TABLE mail_send_log ADD COLUMN from_address TEXT;
