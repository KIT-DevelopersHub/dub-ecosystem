-- mo3-mobile-bff free-tier outbox (@dub/freeq). Free-plan replacement for the paid
-- AUDIT_QUEUE producer (dub-q-audit-record): publishAudit INSERTs one row per push
-- delivery-failure audit record and a Cron-triggered drain forwards it to audit-log
-- (POST /internal/audit-async). Un-namespaced (`freeq_`) table on the shared dub-core D1
-- (binding DB_MOBILE); it is infra plumbing, not @dub/db mobile_ business-namespace data,
-- so it never collides with the mobile_* tables. Idempotent — safe to run alongside the
-- mail-gateway / auth-service copies (all share the same dub-core freeq_outbox). Keep in
-- lockstep with @dub/freeq OUTBOX_DDL.
CREATE TABLE IF NOT EXISTS freeq_outbox (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS freeq_outbox_ready ON freeq_outbox (status, next_attempt_at);
