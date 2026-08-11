-- file-meta audit outbox (@dub/freeq). Free-tier replacement for the
-- dub-q-audit-record Cloudflare Queue producer (publishAudit): the service INSERTs one
-- row per audit event and a Cron-triggered drain (src/drain.ts) forwards it to
-- audit-log (POST /internal/audit-async). Un-namespaced (`freeq_`) table on the shared
-- dub-core D1 (binding DB); it is infra plumbing, not @dub/db business-namespace data.
-- Keep in lockstep with @dub/freeq OUTBOX_DDL.
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
