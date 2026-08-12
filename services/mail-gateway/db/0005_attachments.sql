-- mail-gateway (#15) — attachments slice. Additive, forward-only.
-- Mirror of infra/d1/migrations/mail/0005_attachments.sql (kept byte-identical; infra #28
-- is the 正本 / runner, this copy backs the in-memory test schema in test/d1.ts).
-- Stores attachment METADATA only; the file bytes live in R2 (bucket dub-mail-attachments,
-- key = r2_key). One row per attachment, tied to either a sent (mail_send_log.id) or an
-- inbound (mail_inbound.id) message via (message_kind, message_id). No FK (D1 pragma off /
-- cross-table lifecycle handled app-side + retention purge); the index serves the
-- per-message lookup used by the detail views.
CREATE TABLE IF NOT EXISTS mail_attachments (
  id           TEXT PRIMARY KEY,                 -- prefix-ULID (newId("mailatt"))
  message_kind TEXT NOT NULL
               CHECK (message_kind IN ('sent','inbound')),
  message_id   TEXT NOT NULL,                    -- mail_send_log.id | mail_inbound.id
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,                    -- ORG/kind/message_id/att_id in R2
  created_at   TEXT NOT NULL                     -- ISO8601, stamped app-side (no DDL DEFAULT)
);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_msg ON mail_attachments(message_kind, message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_created ON mail_attachments(created_at);
