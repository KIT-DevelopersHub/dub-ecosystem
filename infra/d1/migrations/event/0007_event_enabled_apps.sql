-- namespace: event | owner: event-service (#4). Additive: which launcher apps each
-- event uses (イベント設定 > 使うアプリ). One row per event; `apps` is a JSON array of
-- app ids. NO row = never configured = every app enabled, so every existing event
-- keeps today's behaviour without a backfill. New events get a row with the default
-- set (イベント・ガントチャート・ロール管理) at creation. IF NOT EXISTS: re-runnable.
CREATE TABLE IF NOT EXISTS event_event_apps (
  event_id   TEXT PRIMARY KEY REFERENCES event_events(id),
  apps       TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
