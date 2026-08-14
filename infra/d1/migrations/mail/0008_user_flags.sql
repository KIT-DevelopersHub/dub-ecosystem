-- mail-gateway (改善#8) — per-user thread flags. Additive, forward-only.
-- Star / archive / trash used to live ONLY in the client's in-memory store, so a reload
-- lost them. This table persists them server-side, scoped per user + per thread (Gmail-
-- style: each account has its OWN star/archive/trash view of a conversation). One row per
-- (owner_user_id, thread_id); a missing row means "all flags false" (the default), so a
-- thread never needs a row until it is first flagged.
--   starred  : the user starred the conversation.
--   archived : moved out of the inbox (Gmail "Archive").
--   trashed  : moved to Trash.
-- Booleans are stored as INTEGER 0/1 (D1/SQLite has no bool). No FK (D1 pragma off);
-- retention/lifecycle is app-side. The index serves the per-user bulk load on inbox open.
CREATE TABLE IF NOT EXISTS mail_user_flags (
  owner_user_id TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  starred       INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  trashed       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_user_flags_owner ON mail_user_flags(owner_user_id);
