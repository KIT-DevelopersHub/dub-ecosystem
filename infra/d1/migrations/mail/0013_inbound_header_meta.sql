-- mail-gateway (受信メールの詳細ダイアログ) — delivery details of a received message.
-- Mirror of services/mail-gateway/db/0013_inbound_header_meta.sql (kept byte-identical;
-- infra is the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only; extends mail_inbound (0001) with one nullable column.
--   header_meta_json : JSON MailHeaderMeta (Reply-To / envelope recipient / mailed-by /
--                      DKIM signed-by / TLS). NULL = nothing known, or a pre-0013 row.
ALTER TABLE mail_inbound ADD COLUMN header_meta_json TEXT;
