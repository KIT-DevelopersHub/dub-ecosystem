-- namespace: event | owner: event-service (#4). Additive (#879): the AI digest of an
-- event (one row per event, replaced on each run) and the per-source "last seen"
-- marks the runner diffs against so an unchanged source costs no LLM call and no
-- D1 write. Separate from event_event_details so a digest run never races a human
-- edit's optimistic version lock. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS event_ai_digests (
  event_id     TEXT PRIMARY KEY REFERENCES event_events(id),
  data         TEXT NOT NULL,
  model        TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_ai_digest_sources (
  event_id   TEXT NOT NULL REFERENCES event_events(id),
  source     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, source)
);
