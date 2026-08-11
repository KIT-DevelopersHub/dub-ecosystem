-- usage-meter service — usage_ namespace. Owns the free-tier usage snapshot: one row
-- per (provider, metric_key, capture_day) so the billing-guard dashboard can show the
-- latest used/limit/% per metric AND keep a light daily history for trend.
-- Collected by the MeterDO alarm (daily) + POST /internal/meter/refresh (on-demand),
-- both UPSERTing today's row. Reads never mutate. created_at/updated_at are stamped
-- app-side (nowIso); DDL DEFAULT on timestamps is banned (theme3 D2). No cross-namespace
-- FK (ids/labels are plain strings; billing risk lives entirely in this namespace).

CREATE TABLE IF NOT EXISTS usage_snapshot (
  id                TEXT PRIMARY KEY,              -- prefix-ULID (newId("usage"))
  capture_day       TEXT NOT NULL,                 -- YYYY-MM-DD (UTC) — one row per metric per day
  captured_at       TEXT NOT NULL,                 -- ISO8601 of the latest capture within the day
  provider          TEXT NOT NULL,                 -- 'cloudflare' | 'resend'
  metric_key        TEXT NOT NULL,                 -- 'workers_requests_day' / 'd1_rows_read_day' ...
  label             TEXT NOT NULL,                 -- human label (JP) for the dashboard
  used              REAL,                          -- observed usage; NULL when status='unknown'
  limit_value       REAL NOT NULL,                 -- free-tier ceiling (from the static master)
  pct               REAL,                          -- used/limit*100; NULL when status='unknown'
  unit              TEXT NOT NULL,                 -- 'req/day' / 'rows/day' / 'GB' ...
  overflow_behavior TEXT NOT NULL                  -- what happens at 100%: stop vs metered billing
                    CHECK (overflow_behavior IN ('halt','bill')),
  status            TEXT NOT NULL                  -- ok<70 / warn>=70 / critical>=90 / unknown
                    CHECK (status IN ('ok','warn','critical','unknown')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One row per metric per UTC day: the daily UPSERT collapses re-collections in a day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_snapshot_metric_day
  ON usage_snapshot(provider, metric_key, capture_day);

-- Latest-day lookup for GET /usage/summary.
CREATE INDEX IF NOT EXISTS idx_usage_snapshot_day ON usage_snapshot(capture_day);
