// Migration object for @dub/db applyMigrations (mirrors 0001_init.sql). infra #28 is the
// physical owner; this export lets the unit self-apply in local/preview and tests.
import type { Migration } from "@dub/db";

export const migration0001Init: Migration = {
  id: "0001_init",
  namespace: "webhook",
  up: `
CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('github','google-drive','gmail','stripe')),
  external_id  TEXT NOT NULL,
  event_kind   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('received','processed','failed')),
  queue        TEXT NOT NULL,
  r2_key       TEXT,
  body_size    INTEGER NOT NULL,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  request_id   TEXT NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_webhook_deliveries_source ON webhook_deliveries (source, id);
CREATE INDEX idx_webhook_deliveries_kind ON webhook_deliveries (source, event_kind, id);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries (received_at);
`.trim(),
};

export const WEBHOOK_MIGRATIONS: readonly Migration[] = [migration0001Init];
