-- namespace: event | owner: event-service (#4). Additive: the free block-editor doc
-- ("イベント編集" しおり canvas) for the event hub page — one doc per event, shared
-- by every viewer, editable only by event:write roles. Separate table from
-- event_event_details / event_event_section_layout so the block-doc's optimistic
-- version lock never races a content or section-order edit's.
CREATE TABLE event_event_page_layout (
  event_id   TEXT PRIMARY KEY REFERENCES event_events(id),
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
