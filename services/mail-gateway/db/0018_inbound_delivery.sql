-- mail-gateway (CC/Bcc 宛の同僚に届かない問題) — per-recipient inbound deliveries + send Bcc.
-- Mirror of infra/d1/migrations/mail/0018_inbound_delivery.sql (kept byte-identical, infra
-- is the 正本 / runner, the service copy backs the in-memory test schema in test/d1.ts).
-- Additive, forward-only. No column is dropped or rewritten.
--
-- mail_inbound stays ONE row per RFC Message-ID (body, headers, attachments). Each envelope
-- delivery of that message (Email Routing calls the Worker once per RCPT TO: To, Cc, Bcc and
-- the archive copy) now gets its own mail_inbound_delivery row, so a mail sent To=A Cc=B
-- shows up in BOTH inboxes instead of only the first one ingested.
--   inbound_id    : mail_inbound.id of the message body row
--   owner_user_id : roster user this copy belongs to. NULL = no owner (the archive@ copy,
--                   which is mail:read_all oversight only, or a non-roster address)
--   envelope_to   : lowercased envelope recipient (RCPT TO) of this copy
--   read_at       : per-recipient read state (one person opening it no longer marks it
--                   read for everyone). NULL = unread
-- Uniqueness = message x envelope recipient x owner (NULL owner folded to '') so an Email
-- Routing redelivery of the same copy is an INSERT OR IGNORE no-op.
CREATE TABLE IF NOT EXISTS mail_inbound_delivery (
  id            TEXT PRIMARY KEY,
  inbound_id    TEXT NOT NULL,
  owner_user_id TEXT,
  envelope_to   TEXT NOT NULL,
  read_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_inbound_delivery
  ON mail_inbound_delivery(inbound_id, envelope_to, COALESCE(owner_user_id, ''));
CREATE INDEX IF NOT EXISTS idx_mail_inbound_delivery_owner
  ON mail_inbound_delivery(owner_user_id, inbound_id);

-- Backfill: every existing owned row becomes that owner's delivery (read state carried over),
-- so no mail visible today disappears. The envelope comes from the stored deliveredTo when
-- known (0013), else ''. Re-running is a no-op (INSERT OR IGNORE on the unique index).
INSERT OR IGNORE INTO mail_inbound_delivery
  (id, inbound_id, owner_user_id, envelope_to, read_at, created_at, updated_at)
SELECT
  'maildlv_bf_' || id,
  id,
  owner_user_id,
  lower(COALESCE(CASE WHEN json_valid(header_meta_json) THEN json_extract(header_meta_json, '$.deliveredTo') END, '')),
  read_at,
  created_at,
  created_at
FROM mail_inbound
WHERE owner_user_id IS NOT NULL;

-- Bcc on the send log (Sent detail shows it to the sender only). JSON MailAddress[],
-- NULL = no Bcc / a row sent before this migration.
ALTER TABLE mail_send_log ADD COLUMN bcc_json TEXT;
