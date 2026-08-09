-- notification service (#8) — notif_ namespace. Owns the delivery layer's state:
-- canonical notifications, per-user inbox (in_app source of truth), preferences
-- overrides, delivery records, and the event-idempotency ledger.
-- created_at is stamped app-side (nowIso); DDL DEFAULT on timestamps is banned (theme3 D2).

CREATE TABLE IF NOT EXISTS notif_notifications (
  id            TEXT PRIMARY KEY,             -- prefix-ULID
  type          TEXT NOT NULL,                -- "task.assigned" / "public.inquiry.received" ...
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          TEXT,
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('normal','urgent')),
  dedup_key     TEXT,                         -- NULL allowed; non-NULL is unique
  source        TEXT NOT NULL CHECK (source IN ('queue','api')),
  source_event  TEXT,                         -- subscribed event name (source='queue')
  actor_id      TEXT,                         -- originating user (NULL = system)
  request_id    TEXT NOT NULL,                -- correlation id (envelope.requestId)
  resource_type TEXT,
  resource_id   TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',   -- JSON object
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedup ON notif_notifications(dedup_key)
  WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_type_created ON notif_notifications(type, created_at);

CREATE TABLE IF NOT EXISTS notif_inbox (
  id              TEXT PRIMARY KEY,           -- prefix-ULID (inbox row id)
  notification_id TEXT NOT NULL REFERENCES notif_notifications(id),
  user_id         TEXT NOT NULL,
  read_at         TEXT,                       -- ISO8601 / NULL = unread
  created_at      TEXT NOT NULL,
  UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notif_inbox_user   ON notif_inbox(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_inbox_unread ON notif_inbox(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notif_preferences (
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL,                   -- "*" / "task.*" (prefix) / exact
  channel    TEXT NOT NULL
             CHECK (channel IN ('in_app','email','chat','push')),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE IF NOT EXISTS notif_deliveries (
  id              TEXT PRIMARY KEY,           -- prefix-ULID
  notification_id TEXT NOT NULL REFERENCES notif_notifications(id),
  user_id         TEXT NOT NULL,
  channel         TEXT NOT NULL
                  CHECK (channel IN ('in_app','email','chat','push')),
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sent','failed','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (notification_id, user_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_notif_deliv_status ON notif_deliveries(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_notif_deliv_notif  ON notif_deliveries(notification_id);

-- IdempotencyStore (@dub/events convention: every handler dedups by envelope.id).
CREATE TABLE IF NOT EXISTS notif_processed_events (
  event_id     TEXT PRIMARY KEY,             -- envelope.id (producer ULID)
  processed_at TEXT NOT NULL
);
