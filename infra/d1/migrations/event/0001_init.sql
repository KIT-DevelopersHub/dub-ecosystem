-- namespace: event | owner: event-service (#4). Aligned to frozen @dub/types event.
CREATE TABLE event_events (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  phase       TEXT NOT NULL,
  starts_at   TEXT,
  ends_at     TEXT,
  version     INTEGER NOT NULL,
  archived_at TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_event_events_org_phase ON event_events(org_id, phase) WHERE archived_at IS NULL;
CREATE INDEX idx_event_events_org_starts ON event_events(org_id, starts_at);
CREATE TABLE event_actions (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES event_events(id),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  archived_at TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_event_actions_event ON event_actions(event_id, sort_order) WHERE archived_at IS NULL;
CREATE INDEX idx_event_actions_kind ON event_actions(event_id, kind);
