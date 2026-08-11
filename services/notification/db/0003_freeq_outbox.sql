-- notification audit outbox (@dub/freeq). Free-tier replacement for the paid
-- dub-q-audit-record Cloudflare Queue producer (AUDIT_QUEUE): the delivery path INSERTs
-- one row per best-effort delivery-failed audit record and a Cron-triggered drain
-- forwards it to audit-log (/internal/audit-async). Un-namespaced (`freeq_`) table on the
-- shared dub-core D1 (bound as OUTBOX_DB); it is infra plumbing, not @dub/db notif_
-- business-namespace data, so it never collides with the notif_* tables. Keep in lockstep
-- with @dub/freeq OUTBOX_DDL. IF NOT EXISTS so it is shared/idempotent across services.
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
