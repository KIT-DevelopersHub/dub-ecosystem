-- namespace: identity | owner: identity-roster (#3)
-- Aggregated into infra/d1 (物理集約が正本). Semantic source: identity-roster.md §3.
-- Single-org model: identity_users carries org_id directly. Timestamps app-set
-- (nowIso); DDL DEFAULT on datetimes is banned (theme-3 D2).
CREATE TABLE IF NOT EXISTS identity_orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_users (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES identity_orgs(id),
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  github_login TEXT UNIQUE,
  avatar_url   TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','invited','disabled','rejected')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS identity_roles (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES identity_orgs(id),
  name       TEXT NOT NULL,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, name)
);

-- relational child table (permission bundle); intentionally has no timestamps.
CREATE TABLE IF NOT EXISTS identity_role_permissions (
  role_id        TEXT NOT NULL REFERENCES identity_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS identity_role_assignments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES identity_users(id),
  role_id       TEXT NOT NULL REFERENCES identity_roles(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES identity_orgs(id),
  resource_type TEXT,
  resource_id   TEXT,
  granted_by    TEXT NOT NULL REFERENCES identity_users(id),
  granted_at    TEXT NOT NULL
);

-- SQLite treats NULLs as distinct in UNIQUE, so dedupe org-wide grants via COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_role_assignments_scope
  ON identity_role_assignments (user_id, role_id, org_id,
    COALESCE(resource_type, ''), COALESCE(resource_id, ''));

CREATE INDEX IF NOT EXISTS idx_identity_role_assignments_user
  ON identity_role_assignments (user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_identity_role_assignments_resource
  ON identity_role_assignments (resource_type, resource_id);
