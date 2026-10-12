-- namespace: identity | owner: identity-roster (#3)
-- `lp:publish` (switch which LP version is live on hokuriku-it-conf.com from LP管理) was added
-- to the frozen PERMISSION_CATALOG. The super-admin invariant (infra/d1 seed test:
-- admin ⊇ PERMISSION_CATALOG) requires role_sys_admin to hold it. NO other role is granted
-- it — publishing is opted into per role in ロール管理 (LP管理 の 詳細).
-- Forward-only + idempotent via INSERT OR IGNORE (0003-0015 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','lp:publish');
