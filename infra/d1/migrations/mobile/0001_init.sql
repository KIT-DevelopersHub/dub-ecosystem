-- namespace: mobile | owner: mobile-bff MO3 (#31). DDL 正本 = MO3 design; infra only
-- aggregates. AGGREGATION STUB pending MO3's DDL: minimal device registry so the
-- namespace materializes. Reconcile at the mobile implementation wave. No seed data.
CREATE TABLE mobile_devices (
  id            TEXT PRIMARY KEY,            -- newId('mdev')
  user_id       TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios','android')),
  push_token    TEXT,
  app_version   TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (user_id, push_token)
);
CREATE INDEX idx_mobile_devices_user ON mobile_devices(user_id);
