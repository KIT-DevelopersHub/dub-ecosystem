-- mail-gateway (受信メールの CC 表示) — Cc header recipients of a received message.
-- Mirror of infra/d1/migrations/mail/0012_inbound_cc.sql (kept byte-identical; infra
-- is the 正本 / runner, this copy backs the in-memory test schema in test/d1.ts).
-- Additive, forward-only; extends mail_inbound (0001) with one nullable column.
--   cc_json : JSON MailAddress[] parsed from the Cc: header. NULL = no Cc, or a row
--             stored before this migration (shown without Cc).
ALTER TABLE mail_inbound ADD COLUMN cc_json TEXT;
