-- deploy-service free-tier outbox (@dub/freeq). Free-plan replacement for the paid
-- Cloudflare Queue producers (dub-q-audit-record / dub-q-evt-notification / the private
-- dub-q-deploy-jobs): the publishers INSERT one row per audit/event/job record and a Cron
-- drain forwards it to the real consumer (audit-log HTTP / notification / this worker's own
-- in-process deploy-job handler). Un-namespaced (`freeq_`) table on the shared dub-core D1
-- (binding DB); it is infra plumbing, not @dub/db deploy_ business-namespace data, so it
-- never collides with the deploy_* tables and is SHARED with the other free-tier services'
-- outboxes. Idempotent (CREATE TABLE IF NOT EXISTS): a no-op if mail-gateway / auth-service
-- already created it. Keep in lockstep with @dub/freeq OUTBOX_DDL.
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
