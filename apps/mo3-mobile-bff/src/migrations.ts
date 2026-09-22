// Forward-only migrations for the mobile_* namespace. Physical files ultimately
// live in infra/d1/migrations/mobile/ (#28 owns/applies); this array is the P0
// source until then. 0001 creates devices + push_deliveries; 0002 adds the
// offline-sync pair (change_log + mutations) consumed/produced by the sync wave.
import type { Migration } from "@dub/db";

export const MOBILE_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_init",
    namespace: "mobile",
    up: `
CREATE TABLE mobile_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('ios','android')),
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
`.trim(),
  },
  {
    // Offline differential-sync pair. mobile_change_log is an append-only, ordered
    // feed (seq = monotonic pull cursor) built by the dub-q-evt-mobile-bff consumer
    // from task.*/event.*/action.* events; mobile clients pull rows after their last
    // seq. mobile_mutations is the client-submitted mutation queue (idempotent on the
    // client-minted id) for offline writes replayed on reconnect. change_log is
    // append-only, so it intentionally has no updated_at.
    id: "0002_offline_sync",
    namespace: "mobile",
    up: `
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
`.trim(),
  },
  {
    // Additive: loosen mobile_devices.platform CHECK from ('ios','android') to the
    // 4 push-capable platforms ('ios','android','macos','windows') for the de1-desktop
    // WebView shell (macOS = APNs, Windows = WNS). SQLite cannot ALTER a CHECK in place,
    // so this is the documented 4-step table rebuild (create-new / copy / drop / rename).
    // No PRAGMA (lint-forbidden): D1 applies migrations with FK enforcement deferred, and
    // mobile_push_deliveries' FK references mobile_devices *by name*, which the final
    // RENAME restores — so the child FK stays valid. Existing rows are preserved verbatim
    // (only the constraint widens), making this a purely additive, non-lossy change.
    id: "0003_devices_platform_4values",
    namespace: "mobile",
    up: `
CREATE TABLE mobile_devices_new (
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
INSERT INTO mobile_devices_new (id, user_id, platform, push_token, app_version, locale, disabled_at, last_seen_at, created_at)
  SELECT id, user_id, platform, push_token, app_version, locale, disabled_at, last_seen_at, created_at FROM mobile_devices;
DROP TABLE mobile_devices;
ALTER TABLE mobile_devices_new RENAME TO mobile_devices;
CREATE INDEX idx_mobile_devices_user ON mobile_devices(user_id) WHERE disabled_at IS NULL;
`.trim(),
  },
];
