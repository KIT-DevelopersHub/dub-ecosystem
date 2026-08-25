-- app-health-monitor durable state, on the SHARED dub-core D1 (un-namespaced, same convention
-- as freeq_outbox). Forward-only + idempotent (CREATE ... IF NOT EXISTS), so re-applying is a
-- no-op. Apply once to dub-core:
--   npx wrangler d1 execute dub-core --remote --file services/app-health-monitor/db/0001_monitor.sql

-- Latest health of every monitored target (flapping source of truth).
CREATE TABLE IF NOT EXISTS monitor_status (
  target_id         TEXT PRIMARY KEY,     -- e.g. "fe:mail" | "svc:notification" | "svc:api-gateway"
  kind              TEXT NOT NULL,        -- 'frontend' | 'service'
  label             TEXT NOT NULL,        -- human name shown in alerts / the status table
  status            TEXT NOT NULL,        -- 'ok' | 'down'
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  down_since        TEXT,                 -- ISO of the first fail in the current down streak
  notified          INTEGER NOT NULL DEFAULT 0, -- 1 = admins already alerted for this streak
  last_error        TEXT,                 -- last probe failure detail
  last_checked_at   TEXT NOT NULL,        -- ISO of the last poll that touched this row
  updated_at        TEXT NOT NULL
);

-- Append-only transition log (down / recovery) for admin visibility + post-incident review.
CREATE TABLE IF NOT EXISTS monitor_incident (
  id        TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  label     TEXT NOT NULL,
  kind      TEXT NOT NULL,   -- 'down' | 'recovery'
  detail    TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_incident_at ON monitor_incident(at);
CREATE INDEX IF NOT EXISTS idx_monitor_incident_target ON monitor_incident(target_id, at);
