-- mail-gateway — per-user sender block list (この送信者をブロック). Additive, forward-only.
-- Mirror of services/mail-gateway/db/0021_sender_blocks.sql (kept byte-identical; infra is
-- the 正本 / runner, the service copy backs the in-memory test schema).
--
-- One row per (owner_user_id, value): the signed-in user blocked either one sender address
-- (kind='address', value = lowercased "local@domain") or a whole sender domain
-- (kind='domain', value = lowercased "example.com"). Personal like mail_user_flags: each
-- account has its OWN list, never org-wide.
-- Blocking NEVER deletes or drops mail (no-silent-delete policy, #696): inbound from a
-- blocked sender is still stored as usual; reads match the from address against this table
-- at QUERY time and mark the item `blocked`, so the client keeps it out of 受信トレイ /
-- unread counts and lists it under ブロック済み — and unblocking restores
-- it. Unblocking is itself a SOFT delete (deleted_at stamped, row kept for the audit trail;
-- no raw DELETE outside src/destructive.ts); re-blocking revives the row. Timestamps app-side
-- (theme3 D2). No FK (D1 pragma off).
CREATE TABLE IF NOT EXISTS mail_sender_blocks (
  owner_user_id TEXT NOT NULL,
  value         TEXT NOT NULL,                                        -- lowercased address or domain
  kind          TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
  created_at    TEXT NOT NULL,                                        -- ISO8601, stamped app-side
  deleted_at    TEXT,                                                 -- unblocked at; NULL = active
  PRIMARY KEY (owner_user_id, value)
);
CREATE INDEX IF NOT EXISTS idx_mail_sender_blocks_owner ON mail_sender_blocks(owner_user_id);
