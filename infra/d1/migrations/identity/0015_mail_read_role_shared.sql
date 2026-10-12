-- namespace: identity | owner: identity-roster (#3)
-- `mail:read_role_shared` (role-level mail sharing: holders of a role carrying this key see
-- each other's inbound mail) was added to the frozen PERMISSION_CATALOG. The super-admin
-- invariant (infra/d1 seed test: admin ⊇ PERMISSION_CATALOG) requires role_sys_admin to hold
-- it. Behaviourally a no-op for admin: admin already holds mail:read_all, which mail-gateway
-- checks first. NO other role is granted it — sharing is opted into per role in ロール管理.
-- Forward-only + idempotent via INSERT OR IGNORE (0003-0014 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','mail:read_role_shared');
