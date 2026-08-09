-- github-sync D1 schema (github_* namespace of shared dub-core).
-- Canonical migration file belongs in infra/d1/migrations/github/ (P0b "D1・migration運用");
-- this copy is kept in-service for reference + local test bootstrap only.

CREATE TABLE github_repos (
  id                TEXT PRIMARY KEY,
  owner             TEXT NOT NULL,
  repo              TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  default_action_id TEXT,
  origin            TEXT NOT NULL DEFAULT 'github'
                    CHECK (origin IN ('internal','github')),
  direction         TEXT NOT NULL DEFAULT 'bidirectional'
                    CHECK (direction IN ('bidirectional','internal_to_github','github_to_internal')),
  enabled           INTEGER NOT NULL DEFAULT 1,
  installation_id   TEXT,
  project_number    INTEGER,
  label_filter      TEXT NOT NULL DEFAULT '[]',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (owner, repo)
);

CREATE TABLE github_links (
  id                     TEXT PRIMARY KEY,
  task_id                TEXT NOT NULL UNIQUE,
  repo_id                TEXT NOT NULL REFERENCES github_repos(id),
  owner                  TEXT NOT NULL,
  repo                   TEXT NOT NULL,
  issue_number           INTEGER NOT NULL,
  issue_node_id          TEXT NOT NULL,
  project_item_id        TEXT,
  sync_state             TEXT NOT NULL DEFAULT 'pending'
                         CHECK (sync_state IN ('in_sync','pending','conflict','error')),
  last_synced_at         TEXT,
  last_github_updated_at TEXT,
  last_task_version      INTEGER,
  last_error             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (repo_id, issue_number)
);

CREATE INDEX idx_github_links_repo  ON github_links(repo_id, sync_state);
CREATE INDEX idx_github_links_state ON github_links(sync_state);

CREATE TABLE github_sync_runs (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL
               CHECK (scope IN ('all','repo','task','event','webhook','cron')),
  repo_id      TEXT REFERENCES github_repos(id),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','succeeded','partial_failed','failed')),
  stats        TEXT NOT NULL DEFAULT '{}',
  triggered_by TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_github_runs_status ON github_sync_runs(status, created_at);

CREATE TABLE github_processed_events (
  event_id     TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
