-- namespace: mobile | owner: mobile-bff MO3 (#31).
-- Reconcile the 0001 aggregation stub with the schema mo3-mobile-bff actually queries
-- (apps/mo3-mobile-bff/src/migrations.ts 0001-0003). The stub lacks locale/disabled_at,
-- has UNIQUE (user_id, push_token) instead of (platform, push_token), only allows
-- ios/android, and the push/sync tables were never created — so POST /m/v1/devices
-- returned 500 on both staging and prod.
--
-- The stub table is DROPPED and recreated: it held 0 rows on dub-core and
-- dub-core-staging (checked 2026-10-13), and no row could be written since every
-- insert failed against it. Nothing references it yet. This DROP carries a documented
-- lint exemption (infra/d1/src/lint-all.ts).
DROP TABLE mobile_devices;

CREATE TABLE mobile_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('ios','android','macos','windows')),
  push_token   TEXT NOT NULL,
  app_version  TEXT,
  locale       TEXT,
  disabled_at  TEXT,
  last_seen_at TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (platform, push_token)
);
CREATE INDEX idx_mobile_devices_user ON mobile_devices(user_id) WHERE disabled_at IS NULL;

CREATE TABLE mobile_push_deliveries (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  device_id       TEXT NOT NULL REFERENCES mobile_devices(id),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','token_invalid')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (notification_id, device_id)
);
CREATE INDEX idx_mobile_push_status ON mobile_push_deliveries(status, updated_at);

CREATE TABLE mobile_change_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL,
  event_name   TEXT NOT NULL,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('event','action','task')),
  entity_id    TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  actor_id     TEXT,
  occurred_at  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (event_id)
);
CREATE INDEX idx_mobile_change_log_entity ON mobile_change_log(entity_type, entity_id);

CREATE TABLE mobile_mutations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  device_id    TEXT REFERENCES mobile_devices(id),
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  payload_json TEXT NOT NULL,
  result_json  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_mobile_mutations_user ON mobile_mutations(user_id, status);
