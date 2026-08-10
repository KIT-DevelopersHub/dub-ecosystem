-- mail-gateway free-tier outbox (@dub/freeq). Free-plan replacement for the paid
-- Cloudflare Queue producers (dub-q-audit-record / dub-q-evt-*): the publishers INSERT
-- one row per audit/domain-event record and a Cron-triggered drain forwards it to the
-- real consumer. Un-namespaced (`freeq_`) table on the shared dub-core D1 (binding DB);
-- it is infra plumbing, not @dub/db mail_ business-namespace data, so it never collides
-- with the mail_* tables. Keep in lockstep with @dub/freeq OUTBOX_DDL.
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
