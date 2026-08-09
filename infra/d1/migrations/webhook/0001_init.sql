-- namespace: webhook | owner: webhook-ingest (#13).
-- AGGREGATION STUB: the owner unit had no DDL file at the P0b snapshot; this is the
-- minimal frozen shape from the design table list (webhook_deliveries, renamed to
-- plural per theme-3). Reconcile with the owner's DDL at integration. No seed data.
CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,            -- newId('whd')
  source        TEXT NOT NULL,               -- ':source' path segment (github/stripe/...)
  event_type    TEXT NOT NULL,               -- provider event type
  external_id   TEXT,                        -- provider delivery id (dedup key)
  payload_hash  TEXT NOT NULL,               -- FNV-1a of raw body
  status        TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','forwarded','rejected','failed')),
  received_at   TEXT NOT NULL,               -- ISO8601 (ingest clock)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_webhook_deliveries_source ON webhook_deliveries(source, received_at);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status, updated_at);
