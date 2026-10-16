-- namespace: identity | owner: identity-roster (#3)
-- カレンダー の「予定を登録」(予定の追加/変更/削除) gets its own toggle in
-- ロール管理 > カレンダー > 細かい権限, backed by a new catalog key:
--   calendar:schedule_edit  (the 予定を作成 affordances in the カレンダー app)
-- Default: ON for the system admin role (also the super-admin invariant
-- role_sys_admin ⊇ PERMISSION_CATALOG). Backfill: every role that already holds
-- app:calendar:edit could add 予定 before this key existed, so it keeps that ability.
-- Every other role starts OFF — admins opt roles in from ロール管理.
-- Forward-only + idempotent via INSERT OR IGNORE (0003-0021 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','calendar:schedule_edit');

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'calendar:schedule_edit' FROM identity_role_permissions
  WHERE permission_key = 'app:calendar:edit';
