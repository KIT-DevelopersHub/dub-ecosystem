-- namespace: task | owner: task-service (#5).
-- 判断44/61: a task's link to an event becomes OPTIONAL (see PR #214). The Event entity
-- still exists (event-service / FE3); only the task->event coupling is relaxed so a task
-- may be issued unlinked (event_id IS NULL). This drops the NOT NULL constraint on
-- task_tasks.event_id.
--
-- SQLite has no `ALTER COLUMN DROP NOT NULL`, so this is a data-preserving table rebuild.
-- NON-DESTRUCTIVE: every existing row is copied verbatim; no column is dropped and no
-- data is lost. Existing tasks keep their event_id; only future inserts may set it NULL.
--
-- FK-safe rebuild: task_dependencies has FKs REFERENCES task_tasks(id). We rename the old
-- table aside, recreate task_tasks under its ORIGINAL name (so declaredTables/verify still
-- see exactly `task_tasks` — the temp name never appears in a CREATE TABLE), copy rows,
-- then drop the old table. `legacy_alter_table=ON` keeps RENAME from rewriting the child
-- FK text (so it stays pointing at the recreated `task_tasks`), and `foreign_keys=OFF`
-- guards the swap. These PRAGMA/DROP statements are why this migration carries a documented
-- lint exemption (infra/d1/src/lint-all.ts) — the frozen namespaces normally forbid them.
PRAGMA foreign_keys=OFF;
PRAGMA legacy_alter_table=ON;

ALTER TABLE task_tasks RENAME TO task_tasks_old;

CREATE TABLE task_tasks (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT,  -- was: TEXT NOT NULL (判断44: optional event link)
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

INSERT INTO task_tasks (id, event_id, title, description, status, priority, assignee_id,
                        due_at, origin, version, due_soon_notified_at, created_by,
                        created_at, updated_at, archived_at)
  SELECT id, event_id, title, description, status, priority, assignee_id, due_at, origin,
         version, due_soon_notified_at, created_by, created_at, updated_at, archived_at
  FROM task_tasks_old;

DROP TABLE task_tasks_old;

-- Recreate every index that existed on the old table (0001_init + 0002_created_by_index).
CREATE INDEX idx_task_tasks_event ON task_tasks(event_id, status);
CREATE INDEX idx_task_tasks_assignee ON task_tasks(assignee_id, status);
CREATE INDEX idx_task_tasks_due ON task_tasks(due_at) WHERE archived_at IS NULL;
CREATE INDEX idx_task_tasks_created_by ON task_tasks(created_by, status);

PRAGMA legacy_alter_table=OFF;
PRAGMA foreign_keys=ON;
