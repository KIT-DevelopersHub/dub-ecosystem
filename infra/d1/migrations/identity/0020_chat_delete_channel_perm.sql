-- namespace: identity | owner: identity-roster (#3)
-- チャット の「チャンネルを削除」(physical delete, unlike archive) gets its own toggle in
-- ロール管理 > チャット > 細かい権限, backed by a new catalog key:
--   chat:delete_channel  (DELETE /chat/channels/:id — channel, messages and all child rows)
-- Default: ON for the system admin role only (also the super-admin invariant
-- role_sys_admin ⊇ PERMISSION_CATALOG). Every other role starts OFF — admins opt roles in
-- from ロール管理. Forward-only + idempotent via INSERT OR IGNORE (0003-0019 convention; 0019 is taken by #641).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','chat:delete_channel');
