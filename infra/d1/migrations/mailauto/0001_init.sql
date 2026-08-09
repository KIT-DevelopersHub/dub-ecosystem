-- namespace: mailauto | owner: mail-automation (#16). Frozen (DDL stable per design).
-- AGGREGATION STUB: owner unit had no DDL file at the P0b snapshot; minimal shape
-- from the design table list (rules/templates/decisions/thread_state/rate_counters/
-- settings). Reconcile with the owner's DDL at integration. No seed data.
CREATE TABLE mailauto_rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  match_json TEXT NOT NULL DEFAULT '{}',
  action     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mailauto_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mailauto_decisions (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  rule_id    TEXT REFERENCES mailauto_rules(id),
  outcome    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mailauto_decisions_thread ON mailauto_decisions(thread_id, created_at);

CREATE TABLE mailauto_thread_state (
  thread_id  TEXT PRIMARY KEY,
  state      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE mailauto_rate_counters (
  bucket     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  window_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mailauto_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
