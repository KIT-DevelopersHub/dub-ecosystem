-- namespace: driveshare | owner: drive-share-service (role-based Google Drive sharing)
-- Role-based Drive sharing lives in Google Drive itself (permissions.*); this namespace
-- only records WHICH role is granted to WHICH file, and — critically — EXACTLY which
-- Drive permissions WE created on behalf of a role grant. That provenance ledger
-- (driveshare_role_grant_members.created_by_us) is the safety mechanism: on revoke /
-- reconcile we only ever delete permissions we created, never individual/pre-existing
-- shares. All timestamps are written by the service (nowIso), never via DDL DEFAULT (D2).

-- One row per (org, file, role) grant. UNIQUE(org_id, file_id, role_id) makes POST an
-- idempotent UPSERT. drive_role is the Drive capability the role's members receive.
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

-- Provenance ledger: the exact Drive permissions materialised for a grant's members.
-- created_by_us = 1 -> we created the Drive permission (safe to delete on revoke);
-- created_by_us = 0 -> a permission already pre-existed for this email (individual
-- share) -> NEVER delete it. permission_id is the Drive permission id (nullable: a
-- member row may exist before its Drive permission id is known).
CREATE TABLE driveshare_role_grant_members (
  grant_id      TEXT NOT NULL REFERENCES driveshare_role_file_grants(id),
  email         TEXT NOT NULL,
  permission_id TEXT,
  created_by_us INTEGER NOT NULL,
  PRIMARY KEY (grant_id, email)
);
CREATE INDEX idx_driveshare_grant_members_grant ON driveshare_role_grant_members(grant_id);
