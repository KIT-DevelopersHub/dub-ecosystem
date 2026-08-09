// task-service D1 schema (task_* namespace). The physical migration正本 lives in
// infra/d1/migrations/task/ (#28 owns/applies); this module keeps the DDL as a
// @dub/db Migration[] so the service stays self-contained and lint-checkable.
// Shape follows the FROZEN @dub/types task namespace (leaner than the P0a draft:
// no action_id / parent_task_id / watchers / labels / start_at).
import type { Migration } from "@dub/db";

export const TASK_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_init",
    namespace: "task",
    up: `
CREATE TABLE task_tasks (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL,
  title                TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'todo'
                       CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
  priority             TEXT NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('low','medium','high','urgent')),
  assignee_id          TEXT,
  due_at               TEXT,
  origin               TEXT NOT NULL DEFAULT 'internal'
                       CHECK (origin IN ('internal','github')),
  version              INTEGER NOT NULL DEFAULT 1,
  due_soon_notified_at TEXT,
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  archived_at          TEXT
);
CREATE INDEX idx_task_tasks_event ON task_tasks(event_id, status);
CREATE INDEX idx_task_tasks_assignee ON task_tasks(assignee_id, status);
CREATE INDEX idx_task_tasks_due ON task_tasks(due_at) WHERE archived_at IS NULL;

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES task_tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES task_tasks(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX idx_task_deps_depends_on ON task_dependencies(depends_on_id);

-- consumer idempotency ledger (envelope.id dedup for the task Queue lane).
CREATE TABLE task_idempotency (
  envelope_id  TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
`.trim(),
  },
];
