// Forward-only migrations for the mobile_* namespace. Physical files ultimately
// live in infra/d1/migrations/mobile/ (#28 owns/applies); this array is the P0
// source until then. Only devices + push_deliveries are created in P0 —
// change_log / mutations are STUB (theme14 D2) and deferred to the offline wave.
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
];
