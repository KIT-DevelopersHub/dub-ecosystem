-- mail-gateway (データ保全 Phase 1) — soft-delete marker for the destructive-op guard.
-- Mirror of services/mail-gateway/db/0016_soft_delete.sql (kept byte-identical; infra is
-- the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only. Any bulk delete must go through src/destructive.ts
-- (guardedBulkDelete): it is off unless MAIL_DESTRUCTIVE_OPS="on", stamps deleted_at
-- first, and only physically removes rows whose deleted_at is older than the grace period.
--   deleted_at : ISO8601 when the row was soft-deleted; NULL = live (every existing row).
ALTER TABLE mail_inbound ADD COLUMN deleted_at TEXT;
ALTER TABLE mail_send_log ADD COLUMN deleted_at TEXT;
