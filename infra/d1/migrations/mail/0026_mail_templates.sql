-- mail-gateway (#867) — templates (定型文). Additive, forward-only.
-- Mirror of infra/d1/migrations/mail/0026_mail_templates.sql (kept byte-identical; infra is
-- the 正本 / runner, the service copy backs the in-memory test schema).
--
--   mail_templates : a saved subject + body a member inserts when composing. Personal to its
--                    owner; the id is client-minted (like mail_drafts), so the composite PK
--                    keeps two accounts' ids apart. One row per template, written only on
--                    save / delete (never per mail).
CREATE TABLE IF NOT EXISTS mail_templates (
  owner_user_id TEXT NOT NULL,
  id            TEXT NOT NULL,
  title         TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  text_body     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,                    -- ISO8601, stamped app-side (no DDL DEFAULT)
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,                             -- soft delete, like every mail table
  PRIMARY KEY (owner_user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_mail_templates_owner_updated ON mail_templates(owner_user_id, updated_at);
