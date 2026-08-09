-- webhook-ingest (#13) — namespace "webhook". Owned physically by infra #28
-- (infra/d1/migrations/webhook/); kept here so this unit is self-contained until
-- infra picks it up. Conventions: plural table (D10), NO DDL DEFAULT (D2, app nowIso()),
-- prefix-ULID PK via newId("wh"). Dedup = UNIQUE(source, external_id) + INSERT OR IGNORE.
-- Status enum matches @dub/types webhook.WebhookDeliveryStatus (received/processed/failed).
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
