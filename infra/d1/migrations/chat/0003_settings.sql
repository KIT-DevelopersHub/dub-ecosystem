-- namespace: chat | owner: chat-service (#17). DRAFT — 凍結対象外 (linted, gate-excluded).
-- Forward-only add-on for the org-scoped message deletion policy (RBAC-configurable
-- delete behaviour). Additive: no change to 0001/0002 tables, so their applied ledger
-- hashes are untouched (no DB_MIGRATION_DRIFT). No cross-namespace FK; the mode columns
-- are CHECK-guarded to { hard, tombstone }; version backs optimistic-concurrency;
-- updated_at/updated_by are app-supplied (no DDL DEFAULT datetime, D2). Absence of a row
-- = the in-code default (all `hard`).
CREATE TABLE chat_settings (
  org_id             TEXT PRIMARY KEY,
  deletion_member    TEXT NOT NULL CHECK (deletion_member IN ('hard','tombstone')),
  deletion_moderator TEXT NOT NULL CHECK (deletion_moderator IN ('hard','tombstone')),
  version            INTEGER NOT NULL,
  updated_at         TEXT NOT NULL,
  updated_by         TEXT
);
