-- auth-service audit outbox (@dub/freeq). Free-tier replacement for the
-- dub-q-audit-record Cloudflare Queue: the producer INSERTs one row per audit
-- event and a Cron-triggered drain forwards it to audit-log. Un-namespaced
-- (`freeq_`) table name on auth-service's own D1 (binding OUTBOX_DB); it is infra
-- plumbing, not @dub/db business-namespace data. Keep in lockstep with
-- @dub/freeq OUTBOX_DDL.
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
