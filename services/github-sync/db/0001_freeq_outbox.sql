-- github-sync free-tier outbox (@dub/freeq). Free-plan replacement for the paid Cloudflare
-- Queue producers (dub-q-audit-record / dub-q-evt-notification): the publishers INSERT one
-- row per audit/domain-event record and a Cron-triggered drain forwards it to the real
-- consumer. Un-namespaced (`freeq_`) table on the shared dub-core D1 (binding DB); it is
-- infra plumbing, not @dub/db github_ business-namespace data, so it never collides with the
-- github_* tables (github_repos / github_links / github_runs / github_processed_events).
-- Keep in lockstep with @dub/freeq OUTBOX_DDL. Applied out-of-band (like mail-gateway
-- 0003_freeq_outbox.sql / task-service 0002_freeq_outbox.sql), NOT part of the github
-- migrations directory.
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
