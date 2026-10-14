-- namespace: identity | owner: identity-roster (#3)
-- カレンダー > ミーティング (meetings created on the shared Google account by
-- drive-share-service /meetings) gets two toggles in ロール管理 > カレンダー > 細かい権限, backed by
-- two new catalog keys:
--   calendar:meetings_view  (see the meetings and their targets)
--   calendar:meetings_edit  (create / change / delete meetings, sync invitations; implies view)
-- Default: ON for the system admin role only (also the super-admin invariant
-- role_sys_admin ⊇ PERMISSION_CATALOG). Every other role starts OFF — admins opt roles in
-- from ロール管理. Forward-only + idempotent via INSERT OR IGNORE (0003-0018 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','calendar:meetings_view'),
  ('role_sys_admin','calendar:meetings_edit');
