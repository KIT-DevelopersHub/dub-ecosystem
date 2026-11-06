-- mail-gateway (#15) — server drafts + inline-image Content-ID. Additive, forward-only.
-- Mirror of services/mail-gateway/db/0025_drafts_inline_cid.sql (kept byte-identical; infra is
-- the 正本 / runner, the service copy backs the in-memory test schema).
--
--   mail_drafts            : a compose in progress (Gmail 下書き), one row per compose window.
--                            Personal to its owner. Addresses are the raw field text: a draft
--                            may hold a half-typed recipient that would not validate yet.
--   mail_draft_attachments : files of a draft; BYTES in R2 under ORG/drafts/<owner>/<draft>/<att>.
--                            A new table for the reason given in 0020 (message_kind is CHECK-limited).
--   mail_attachments.content_id : Content-ID of an inbound part, so an HTML body's
--                            <img src="cid:..."> can resolve to the stored attachment.
CREATE TABLE IF NOT EXISTS mail_drafts (
  owner_user_id TEXT NOT NULL,
  id            TEXT NOT NULL,                    -- client-minted per compose window
  mode          TEXT NOT NULL DEFAULT 'new',      -- new | reply | replyAll | forward
  to_text       TEXT NOT NULL DEFAULT '',
  cc_text       TEXT NOT NULL DEFAULT '',
  bcc_text      TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  text_body     TEXT NOT NULL DEFAULT '',
  in_reply_to   TEXT,
  created_at    TEXT NOT NULL,                    -- ISO8601, stamped app-side (no DDL DEFAULT)
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,                             -- discarded / sent (soft delete, like every mail table)
  PRIMARY KEY (owner_user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_owner_updated ON mail_drafts(owner_user_id, updated_at);
CREATE TABLE IF NOT EXISTS mail_draft_attachments (
  id            TEXT PRIMARY KEY,                 -- prefix-ULID (newId("mailatt"))
  owner_user_id TEXT NOT NULL,
  draft_id      TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_draft_attachments_draft ON mail_draft_attachments(owner_user_id, draft_id);
ALTER TABLE mail_attachments ADD COLUMN content_id TEXT;
