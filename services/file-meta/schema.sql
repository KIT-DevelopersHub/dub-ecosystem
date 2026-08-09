-- file-meta (#9) — DDL for the `file_meta_*` namespace (semantic source of truth).
-- The PHYSICAL migration file is owned by infra-d1-seed (#28) at
-- infra/d1/migrations/file_meta/000X_*.sql; this file is the reference this service
-- implements against. Conventions (P0b frozen): prefix-ULID ids (newId), timestamps
-- set by app via nowIso() (no DEFAULT clauses), single shared `dub-core` D1.

-- File metadata. Body lives in Drive (drive_file_id) or R2 (r2_key), never here.
CREATE TABLE IF NOT EXISTS file_meta_files (
  id            TEXT PRIMARY KEY,            -- newId('file')
  name          TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  owner_id      TEXT NOT NULL,               -- userId (id ref only, no FK across boundary)
  visibility    TEXT NOT NULL DEFAULT 'org', -- 'org' | 'private'
  drive_file_id TEXT,                        -- Drive raw id (source=drive), else NULL
  r2_key        TEXT,                        -- R2 object key (source=r2), else NULL
  archived_at   TEXT,                        -- logical delete (body kept / lazy-purged)
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- One Drive file registers once (idempotency key for drive.file.created subscription).
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_meta_files_drive ON file_meta_files(drive_file_id) WHERE drive_file_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_meta_files_r2 ON file_meta_files(r2_key) WHERE r2_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_meta_files_owner ON file_meta_files(owner_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_file_meta_files_name ON file_meta_files(name) WHERE archived_at IS NULL;

-- Link registry: the single source of truth for file<->entity links (theme9 frozen;
-- task/event tables must NOT hold fileId). archived_at suppresses a link from search
-- (on *.archived) while preserving the row for audit value.
CREATE TABLE IF NOT EXISTS file_meta_links (
  file_id     TEXT NOT NULL REFERENCES file_meta_files(id),
  target_type TEXT NOT NULL,                 -- 'task' | 'event' | 'action' | 'message'
  target_id   TEXT NOT NULL,                 -- id ref only (no FK across boundary)
  linked_by   TEXT NOT NULL,
  linked_at   TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (file_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_file_meta_links_target ON file_meta_links(target_type, target_id);

-- Consumer idempotency ledger (envelope.id already processed).
CREATE TABLE IF NOT EXISTS file_meta_processed_events (
  event_id     TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
