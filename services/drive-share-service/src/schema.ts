// D1 schema for the `driveshare` namespace. Semantic source of truth for the physical
// migration applied from infra/d1/migrations/driveshare/0001_init.sql. The two MUST stay
// in lockstep (test/schema-lockstep.test.ts) — change this const and that .sql together.
//
// This service otherwise owns NO domain data (Google Drive holds the files/permissions);
// these two tables are only the role→file grant index and the provenance ledger of the
// Drive permissions WE created, so revoke/reconcile never touches individual shares.
import type { Migration } from "@dub/db";

export const DRIVESHARE_SCHEMA_MIGRATION: Migration = {
  namespace: "driveshare",
  id: "0001_init",
  up: `
CREATE TABLE driveshare_role_file_grants (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  drive_role TEXT NOT NULL CHECK (drive_role IN ('reader','commenter','writer')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, file_id, role_id)
);
CREATE INDEX idx_driveshare_grants_org ON driveshare_role_file_grants(org_id);
CREATE INDEX idx_driveshare_grants_file ON driveshare_role_file_grants(org_id, file_id);
CREATE TABLE driveshare_role_grant_members (
  grant_id      TEXT NOT NULL REFERENCES driveshare_role_file_grants(id),
  email         TEXT NOT NULL,
  permission_id TEXT,
  created_by_us INTEGER NOT NULL,
  PRIMARY KEY (grant_id, email)
);
CREATE INDEX idx_driveshare_grant_members_grant ON driveshare_role_grant_members(grant_id);
`.trim(),
};
