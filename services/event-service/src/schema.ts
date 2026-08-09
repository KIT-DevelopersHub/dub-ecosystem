// D1 schema for the `event` namespace. Semantic source of truth for the physical
// migration; the physical file belongs in infra/d1/migrations/event/ (theme12,
// owned by infra-d1-seed #28 — NOT created here to respect unit boundaries).
// Aligned to the FROZEN @dub/types event contract: no slug/venue (dropped in P0b);
// created_by is an internal column (absent from the wire types, used for participants).
import type { Migration } from "@dub/db";

export const EVENT_SCHEMA_MIGRATION: Migration = {
  namespace: "event",
  id: "0001_init",
  up: `
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
`.trim(),
};
