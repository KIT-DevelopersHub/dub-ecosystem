-- mail-gateway (#15) — scheduled send: attachments + Bcc. Additive, forward-only.
-- Mirror of services/mail-gateway/db/0020_scheduled_attachments_bcc.sql (kept byte-identical;
-- infra is the 正本 / runner, the service copy backs the in-memory test schema).
--
-- 0010 parked a scheduled send WITHOUT attachments or Bcc (both were rejected at POST
-- /mail/scheduled). This slice persists them so a scheduled compose / reply goes out with
-- exactly what the user attached and addressed:
--   mail_scheduled.bcc_json   : JSON MailAddress[] of envelope-only Bcc (NULL when none).
--   mail_scheduled_attachments: metadata per parked file; the BYTES live in R2 (same bucket
--                               as mail_attachments) under ORG/scheduled/<sched id>/<att id>.
--                               At delivery the drain reads them back and hands them to the
--                               SAME send core, which persists the Sent copy as usual.
-- A new table (not mail_attachments) because mail_attachments.message_kind is CHECK-limited
-- to ('sent','inbound') and widening it needs a table rebuild. Timestamps app-side (theme3 D2).
ALTER TABLE mail_scheduled ADD COLUMN bcc_json TEXT;
CREATE TABLE IF NOT EXISTS mail_scheduled_attachments (
  id           TEXT PRIMARY KEY,                 -- prefix-ULID (newId("mailatt"))
  scheduled_id TEXT NOT NULL,                    -- mail_scheduled.id
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,                    -- ORG/scheduled/scheduled_id/att_id in R2
  created_at   TEXT NOT NULL                     -- ISO8601, stamped app-side (no DDL DEFAULT)
);
CREATE INDEX IF NOT EXISTS idx_mail_scheduled_attachments_sched ON mail_scheduled_attachments(scheduled_id);
