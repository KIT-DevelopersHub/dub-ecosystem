-- namespace: task | owner: task-service (#5).
-- My Tasks: a task's 内容(description) can carry attachments — uploaded files
-- (blob lives in file-meta/R2; this row is the task↔file index + display meta) and
-- external URLs. Additive & backward-compatible: a brand-new table, no change to
-- task_tasks, so every existing Task read/write path is untouched.
CREATE TABLE task_attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task_tasks(id),
  kind        TEXT NOT NULL CHECK (kind IN ('file','url')),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  -- file: the file-meta download path; url: the external URL. Always present.
  url         TEXT NOT NULL,
  -- file-meta file id when kind='file' (the blob's owner); NULL for a plain url.
  file_id     TEXT,
  mime_type   TEXT,
  size_bytes  INTEGER,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_task_attachments_task ON task_attachments(task_id) WHERE archived_at IS NULL;
