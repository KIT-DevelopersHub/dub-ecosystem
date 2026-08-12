-- mail-gateway (#15) — per-account scope slice. Additive, forward-only.
-- Gmail-style isolation: each account sees ONLY its own sent / received mail.
-- Adds an owner_user_id to both message tables so the read APIs can scope by the
-- signed-in user (identity userId), and enforce authz fail-closed.
--   mail_send_log.owner_user_id : the user who composed the send (POST /mail/outbox
--       resolves it from the caller identity). NULL for pure system/automation sends
--       (no human owner) — those never surface in any person's Sent folder.
--   mail_inbound.owner_user_id  : the roster user the message was delivered TO (resolved
--       from the recipient address via identity lookup at ingest). NULL when no roster
--       user matches (unaddressable / shared mailbox) — invisible to every account until
--       an owner can be assigned (fail-closed; no cross-account leak).
-- Both nullable: existing rows backfill to NULL and simply stop appearing in any
-- user-scoped list (no data loss, no rewrite). A `owner_user_id = ?` filter never matches
-- a NULL row (SQL NULL semantics), which is exactly the fail-closed behaviour we want.
-- No timestamp DEFAULT (theme3 D2). ADD COLUMN only (D1 has no "ADD COLUMN IF NOT
-- EXISTS"), matching the 0002 / 0004 style.
ALTER TABLE mail_send_log ADD COLUMN owner_user_id TEXT;
ALTER TABLE mail_inbound   ADD COLUMN owner_user_id TEXT;

-- Owner-scoped list reads: (owner, order-key) covering indexes so the per-account
-- inbox / sent lists stay index-ordered under the new WHERE owner_user_id = ? filter.
CREATE INDEX IF NOT EXISTS idx_mail_send_log_owner ON mail_send_log(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_inbound_owner  ON mail_inbound(owner_user_id, id);
