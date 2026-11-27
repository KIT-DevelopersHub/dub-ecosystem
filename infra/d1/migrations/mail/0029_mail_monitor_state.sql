-- mail-gateway (メールの本番監視 / #898) — one row per check, overwritten in place.
-- Mirror of services/mail-gateway/db/0029_mail_monitor_state.sql (kept byte-identical;
-- infra is the 正本 / runner, the service copy backs the in-memory test schema).
-- Additive, forward-only; a new table only (no existing table is touched).
--
-- src/monitor.ts writes one row per check name and reads it back by primary key, so the
-- table never grows past a handful of rows (rows-read budget: no scans, no history).
-- History of the send/receive probes stays in mail_canary_probe (0017).
--   check_name          : send | receive | api | send_errors | heartbeat
--   status              : ok | failing (latest result)
--   fail_streak         : consecutive failures (0 when ok)
--   alerting            : 1 while an alert for the current incident has been raised
--   incident_started_at : first failure of the current streak (dedup key of the incident)
--   pending_notice      : alert | recovered — a notice not yet delivered to any channel
--                         (retried on the next run, so a notification outage never eats it)
--   ref                 : check-specific pointer (receive: thread id of the last canary seen)
CREATE TABLE IF NOT EXISTS mail_monitor_state (
  check_name          TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('ok','failing')),
  fail_streak         INTEGER NOT NULL DEFAULT 0,
  alerting            INTEGER NOT NULL DEFAULT 0,
  incident_started_at TEXT,
  pending_notice      TEXT,
  last_run_at         TEXT NOT NULL,
  last_ok_at          TEXT,
  last_detail         TEXT,
  ref                 TEXT,
  updated_at          TEXT NOT NULL
);
