-- namespace: event | owner: event-service (#4). Additive (theme-12): free-form
-- per-event detail store. One row per event holds a JSON `data` document +
-- an optimistic `version`; new detail fields need NO further migration.
CREATE TABLE event_event_details (
  event_id   TEXT PRIMARY KEY REFERENCES event_events(id),
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
