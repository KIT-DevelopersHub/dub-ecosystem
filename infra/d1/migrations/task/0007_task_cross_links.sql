-- namespace: task | owner: task-service (#5).
-- Cross-team links (送る・受け取る / ADR-0007). The arrow-LESS join created when a
-- cross-team request is accepted: it connects the requester's tracking task and the
-- receiver's new task WITHOUT being a dependency. It is intentionally NOT in
-- task_dependencies, so the gantt draws no line and CPM never sees it — the two tasks
-- just carry a role-derived status badge (お願いした / 受け負った).
--
-- NON-DESTRUCTIVE / additive: a brand-new table in the `task` namespace. Applied
-- exactly once via the ledger. FKs stay inside the `task` namespace (ADR-0005).
CREATE TABLE task_cross_links (
  id                TEXT PRIMARY KEY,        -- txl_ ULID
  request_id        TEXT NOT NULL REFERENCES task_requests(id),
  requester_task_id TEXT NOT NULL REFERENCES task_tasks(id),  -- お願いした side (role=requested)
  requestee_task_id TEXT NOT NULL REFERENCES task_tasks(id),  -- 受け負った side (role=accepted)
  event_id          TEXT,                    -- denormalized (both tasks' event) for cheap event lookup
  created_at        TEXT NOT NULL,
  UNIQUE (requester_task_id, requestee_task_id)
);
CREATE INDEX idx_task_cross_links_requester ON task_cross_links(requester_task_id);
CREATE INDEX idx_task_cross_links_requestee ON task_cross_links(requestee_task_id);
CREATE INDEX idx_task_cross_links_event     ON task_cross_links(event_id);
