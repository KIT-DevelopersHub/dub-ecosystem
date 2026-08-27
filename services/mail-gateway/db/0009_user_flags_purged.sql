-- mail-gateway (完全に削除 / purge) — per-user "permanently delete from MY view" flag.
-- Additive, forward-only; extends mail_user_flags (0008) with one more per-user boolean.
--
-- Gmail's "完全に削除": once the user empties a conversation from their Trash it is gone
-- from THEIR mailbox for good (no restore UI). It is still a PER-USER view change, NOT a
-- physical delete — the message body/thread rows are never touched, so an admin (or any
-- other account that received the same conversation) still sees it. Each viewer is filtered
-- ONLY by their OWN purged flag, exactly like trashed. A missing row means purged=false.
--   purged    : the user permanently removed this conversation from their own mailbox.
--   purged_at : when they did (audit/debug only; nullable — null until first purged).
-- Booleans are INTEGER 0/1 (D1/SQLite has no bool). No physical row is ever DELETEd here.
ALTER TABLE mail_user_flags ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_user_flags ADD COLUMN purged_at TEXT;
