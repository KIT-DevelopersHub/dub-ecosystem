-- namespace: identity | owner: identity-roster (#3)
-- Drive共有 の「設定」(the Google accounts drive-share-service acts as) gets its own 無効/閲覧/編集
-- in ロール管理 > Drive共有 > 詳細設定, backed by two new catalog keys:
--   drive:settings_view  (open the settings, read the account list)
--   drive:settings_edit  (add / switch / remove accounts; implies view)
-- Until now the settings were gated on identity:admin. To keep today's behaviour, every role
-- that holds identity:admin (system admin + any custom role an admin gave it) gets BOTH keys;
-- this also satisfies the super-admin invariant (role_sys_admin ⊇ PERMISSION_CATALOG).
-- No other role is granted them — admins opt roles in from ロール管理.
-- Forward-only + idempotent via INSERT OR IGNORE (0003-0015 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'drive:settings_view' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'drive:settings_edit' FROM identity_role_permissions WHERE permission_key = 'identity:admin';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','drive:settings_view'),
  ('role_sys_admin','drive:settings_edit');
