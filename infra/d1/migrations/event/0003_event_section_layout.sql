-- namespace: event | owner: event-service (#4). Additive: shared (org/event-scoped,
-- NOT per-user) section layout for the event detail page — which sections are
-- shown/hidden and their order. Separate table from event_event_details so a
-- layout reorder's optimistic version lock never races a content edit's.
CREATE TABLE event_event_section_layout (
  event_id   TEXT PRIMARY KEY REFERENCES event_events(id),
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
