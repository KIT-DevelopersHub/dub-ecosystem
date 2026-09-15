-- commander (Commander app) — commander_ namespace on the shared dub-core D1.
-- Persists the feature phase state machine that mirrors `Dub_フィーチャー台帳`
-- (1 機能 = 1 エントリ = 1 row). The allowed-edge / approval rules are enforced in
-- code (@dub/commander-phases) before any write here; commander_phase_transitions is
-- the immutable audit log of every accepted move.
-- created_at/updated_at are stamped app-side (nowIso); DDL DEFAULT on timestamps is
-- banned (theme3 D2).

-- One feature = one ledger entry. `phase` is the single mutable state; the string
-- values match @dub/commander-phases FeaturePhase exactly.
CREATE TABLE IF NOT EXISTS commander_features (
  id         TEXT PRIMARY KEY,               -- prefix-ULID ("feat_…")
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  phase      TEXT NOT NULL
             CHECK (phase IN (
               'demo_building','demo_review','demo_rejected',
               'staging_deployed','staging_review','staging_rejected','prod_shipped'
             )),
  ledger_ref TEXT,                            -- link into Dub_フィーチャー台帳 (nullable)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_features_phase
  ON commander_features(phase, updated_at DESC);

-- Work items under a feature (implementation tasks). PoC: minimal.
CREATE TABLE IF NOT EXISTS commander_tasks (
  id         TEXT PRIMARY KEY,               -- prefix-ULID ("ctask_…")
  feature_id TEXT NOT NULL REFERENCES commander_features(id),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status     TEXT NOT NULL
             CHECK (status IN ('todo','doing','done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_tasks_feature
  ON commander_tasks(feature_id, created_at);

-- Immutable audit log: every accepted phase move. actor + approval + when.
-- Append-only (never UPDATEd) -> no updated_at by design.
CREATE TABLE IF NOT EXISTS commander_phase_transitions (
  id               TEXT PRIMARY KEY,          -- prefix-ULID ("ptx_…")
  feature_id       TEXT NOT NULL REFERENCES commander_features(id),
  from_phase       TEXT NOT NULL,
  to_phase         TEXT NOT NULL,
  approved_by_user INTEGER NOT NULL CHECK (approved_by_user IN (0,1)),
  actor            TEXT NOT NULL CHECK (actor IN ('user','system')),
  note             TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_ptx_feature
  ON commander_phase_transitions(feature_id, created_at);

-- A single `claude -p` invocation triggered from the daemon (persisted for audit /
-- history). task_id is nullable (PoC runs may not be tied to a task yet).
CREATE TABLE IF NOT EXISTS commander_runs (
  id         TEXT PRIMARY KEY,               -- prefix-ULID ("run_…")
  task_id    TEXT REFERENCES commander_tasks(id),
  prompt     TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  status     TEXT NOT NULL
             CHECK (status IN ('pending','running','succeeded','failed')),
  exit_code  INTEGER,                         -- NULL until the process exits
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_runs_status
  ON commander_runs(status, updated_at DESC);

-- Append-only stream of events emitted while a run executes. No updated_at by design.
CREATE TABLE IF NOT EXISTS commander_run_events (
  id         TEXT PRIMARY KEY,               -- prefix-ULID ("rev_…")
  run_id     TEXT NOT NULL REFERENCES commander_runs(id),
  type       TEXT NOT NULL
             CHECK (type IN ('status','claude','stdout','stderr','exit','error')),
  payload    TEXT NOT NULL DEFAULT '{}',     -- JSON object
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commander_run_events_run
  ON commander_run_events(run_id, created_at);
