// identity_* schema + reference data as forward-only @dub/db migrations. The
// semantic source of truth is identity-roster.md §3; the physical migration files
// belong under infra/d1/migrations/identity/ (theme-12, owned by #28). This module
// is the shared definition — infra imports IDENTITY_MIGRATIONS rather than copying
// SQL, and the test suite applies it against the mem store's equivalents.
//
// Single-org model: identity_users carries org_id directly (frozen IdentityUser
// exposes a single orgId + roleIds), so the P0a identity_org_members table is
// folded away. Timestamps are app-set (@dub/db nowIso); DDL DEFAULT on datetimes
// is banned (theme-3 D2).
import type { Migration } from "@dub/db";

const SCHEMA_UP = `
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
`;

// Reference data: default org + 3 system roles (α-decided permission bundles).
// Fixed ids/timestamp keep the migration deterministic. Demo USERS are #28's job.
const SEED_ORG_ID = "org_devhub";
const SEED_TS = "2026-01-01T00:00:00.000Z";

function rolePerms(roleId: string, keys: string[]): string {
  return keys.map((k) => `INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES ('${roleId}', '${k}');`).join("\n");
}

const ADMIN_KEYS = ["identity:read", "identity:admin", "event:read", "event:write", "event:admin", "task:read", "task:write", "task:delete", "file:read", "file:write", "file:admin", "notif:send", "notif:admin", "mail:send", "mail:read", "mail:admin", "chat:create", "chat:moderate", "infra:read", "infra:deploy", "infra:dns", "infra:admin", "audit:read"];
// maintainer: full operational + editing power, but no org administration
// (no identity:admin / infra:admin / infra:dns / *:admin integration surfaces).
const MAINTAINER_KEYS = ["identity:read", "event:read", "event:write", "event:admin", "task:read", "task:write", "task:delete", "file:read", "file:write", "notif:send", "notif:admin", "mail:send", "mail:read", "chat:create", "chat:moderate", "infra:read", "infra:deploy", "audit:read", "github:read", "github:write", "github:sync", "drive:read", "drive:write", "webhook:read"];
const ORGANIZER_KEYS = ["identity:read", "event:read", "event:write", "event:admin", "task:read", "task:write", "task:delete", "file:read", "file:write", "notif:send", "chat:create", "infra:read", "audit:read"];
const MEMBER_KEYS = ["identity:read", "event:read", "task:read", "task:write", "file:read", "file:write", "chat:create"];

const SEED_UP = `
INSERT OR IGNORE INTO identity_orgs (id, name, created_at) VALUES ('${SEED_ORG_ID}', 'DevHub', '${SEED_TS}');

INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_admin', '${SEED_ORG_ID}', 'admin', 1, '${SEED_TS}', '${SEED_TS}');
INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_maintainer', '${SEED_ORG_ID}', 'maintainer', 1, '${SEED_TS}', '${SEED_TS}');
INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_organizer', '${SEED_ORG_ID}', 'organizer', 1, '${SEED_TS}', '${SEED_TS}');
INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_member', '${SEED_ORG_ID}', 'member', 1, '${SEED_TS}', '${SEED_TS}');

${rolePerms("role_sys_admin", ADMIN_KEYS)}
${rolePerms("role_sys_maintainer", MAINTAINER_KEYS)}
${rolePerms("role_sys_organizer", ORGANIZER_KEYS)}
${rolePerms("role_sys_member", MEMBER_KEYS)}
`;

// Provenance marker (theme "roster from Email Routing"): rows synced from Cloudflare
// Email Routing carry source='email-routing' so the sync can tell which rows it owns
// (and logically deactivate the ones that disappeared, never hard-deleting — data保全).
// Manually invited/provisioned users stay source='manual'. Forward-only ADD COLUMN with
// a literal DEFAULT is allowed here (the theme-3 D2 ban is on datetime DEFAULTs only).
const SOURCE_UP = `
ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','email-routing'));
`;

export const IDENTITY_MIGRATIONS: Migration[] = [
  { id: "0001_init", namespace: "identity", up: SCHEMA_UP },
  { id: "0002_system_roles", namespace: "identity", up: SEED_UP },
  { id: "0003_user_source", namespace: "identity", up: SOURCE_UP },
];

export const IDENTITY_SCHEMA_SQL = SCHEMA_UP;
