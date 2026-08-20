-- namespace: task | owner: task-service (#5).
-- Cross-team task requests (送る・受け取る / ADR-0007). A request is issued by one
-- user to another; when the receiver is on another team it stays `pending` until the
-- receiver accepts (then a task materialises for their team). Same-team / self requests
-- never create a row here (they become a task directly — D1).
--
-- NON-DESTRUCTIVE / additive: a brand-new table in the `task` namespace. Existing
-- tables + the frozen CRUD paths are untouched. Applied exactly once via the ledger.
CREATE TABLE task_requests (
  id              TEXT PRIMARY KEY,          -- treq_ ULID
  event_id        TEXT,                      -- optional event scope (nullable, like task.event_id)
  from_user_id    TEXT NOT NULL,             -- requester (createdBy)
  to_user_id      TEXT NOT NULL,             -- receiver (assignee once accepted)
  from_team_id    TEXT,                      -- requester team snapshot at issue time
  to_team_id      TEXT,                      -- receiver team (default team_id of the accepted task)
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description     TEXT,
  priority        TEXT NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low','medium','high','urgent')),
  due_at          TEXT,
  source_task_id  TEXT,                      -- requester-side tracking task (auto-made on accept if absent)
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','accepted','declined','cancelled')),
  decline_reason  TEXT,                      -- optional reason on decline
  created_task_id TEXT,                      -- receiver task minted on accept
  version         INTEGER NOT NULL DEFAULT 1,-- optimistic lock (echoed on accept/decline/cancel)
  created_at      TEXT NOT NULL,
  decided_at      TEXT,                      -- accept/decline/cancel timestamp
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_task_requests_to   ON task_requests(to_user_id, state);
CREATE INDEX idx_task_requests_from ON task_requests(from_user_id, state);
CREATE INDEX idx_task_requests_event ON task_requests(event_id);
