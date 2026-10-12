-- namespace: identity | owner: identity-roster (#3)
-- Drive共有 の「設定」(the Google accounts drive-share-service acts as) gets its own two toggles
-- in ロール管理 > Drive共有 > 細かい権限, backed by two new catalog keys:
--   drive:settings_view  (open the settings, read the account list)
--   drive:settings_edit  (add / switch / remove accounts; implies view)
-- Default: ON for the system admin role only (also the super-admin invariant
-- role_sys_admin ⊇ PERMISSION_CATALOG). Every other role starts OFF — admins opt roles in
-- from ロール管理. Forward-only + idempotent via INSERT OR IGNORE (0003-0015 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','drive:settings_view'),
  ('role_sys_admin','drive:settings_edit');
