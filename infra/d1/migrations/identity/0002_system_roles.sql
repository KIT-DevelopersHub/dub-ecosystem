-- namespace: identity | owner: identity-roster (#3)
-- Reference data: default org (org_devhub = DUB_DEFAULT_ORG_ID) + 3 system roles
-- (admin/organizer/member) with α-decided permission bundles. Demo USERS are NOT
-- here (they belong to seed #28, so prod never gets demo accounts). Deterministic
-- fixed ids/timestamp. Idempotent via INSERT OR IGNORE.
INSERT OR IGNORE INTO identity_orgs (id, name, created_at) VALUES ('org_devhub', 'DevelopersHub', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_admin', 'org_devhub', 'admin', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_organizer', 'org_devhub', 'organizer', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO identity_roles (id, org_id, name, is_system, created_at, updated_at)
  VALUES ('role_sys_member', 'org_devhub', 'member', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','identity:read'),('role_sys_admin','identity:admin'),
  ('role_sys_admin','event:read'),('role_sys_admin','event:write'),('role_sys_admin','event:admin'),
  ('role_sys_admin','task:read'),('role_sys_admin','task:write'),('role_sys_admin','task:delete'),
  ('role_sys_admin','file:read'),('role_sys_admin','file:write'),('role_sys_admin','file:admin'),
  ('role_sys_admin','notif:send'),('role_sys_admin','notif:admin'),
  ('role_sys_admin','mail:send'),('role_sys_admin','mail:read'),('role_sys_admin','mail:admin'),
  ('role_sys_admin','chat:create'),('role_sys_admin','chat:moderate'),
  ('role_sys_admin','infra:read'),('role_sys_admin','infra:deploy'),('role_sys_admin','infra:dns'),
  ('role_sys_admin','infra:admin'),('role_sys_admin','audit:read');

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_organizer','identity:read'),
  ('role_sys_organizer','event:read'),('role_sys_organizer','event:write'),('role_sys_organizer','event:admin'),
  ('role_sys_organizer','task:read'),('role_sys_organizer','task:write'),('role_sys_organizer','task:delete'),
  ('role_sys_organizer','file:read'),('role_sys_organizer','file:write'),
  ('role_sys_organizer','notif:send'),('role_sys_organizer','chat:create'),
  ('role_sys_organizer','infra:read'),('role_sys_organizer','audit:read');

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_member','identity:read'),
  ('role_sys_member','event:read'),
  ('role_sys_member','task:read'),('role_sys_member','task:write'),
  ('role_sys_member','file:read'),('role_sys_member','file:write'),
  ('role_sys_member','chat:create');
