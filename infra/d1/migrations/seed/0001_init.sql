-- namespace: seed | owner: infra-d1-seed (#28). The only DDL this unit truly OWNS.
-- Records each idempotent seed run (dataset + run_id + fixture hash) for observability
-- and multi-run isolation. Append-only; exempt from missing-timestamps lint (D13:
-- applied_at only). No DDL DEFAULT (D2) — applied_at is app-set via nowIso().
CREATE TABLE seed_runs (
  id           TEXT PRIMARY KEY,             -- ULID
  dataset      TEXT NOT NULL,                -- 'minimal' | 'conference-demo' | 'rbac-matrix'
  run_id       TEXT NOT NULL,                -- 'fixed' or ULID (isolate run identifier)
  fixture_hash TEXT NOT NULL,
  applied_at   TEXT NOT NULL,                -- nowIso()
  UNIQUE (dataset, run_id, fixture_hash)
);
