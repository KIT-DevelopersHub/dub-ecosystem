-- namespace: identity | owner: identity-roster (#3)
-- チャット の「セクションを管理」gets its own toggle in ロール管理 > チャット > 細かい権限,
-- backed by a new catalog key:
--   chat:manage_sections  (POST/PATCH/DELETE /chat/sections, PUT /chat/channels/:id/section —
--                          the org-wide sidebar sections every member sees, chat/0007)
-- Default: ON for the system admin role only (also the super-admin invariant
-- role_sys_admin ⊇ PERMISSION_CATALOG). Every other role starts OFF — admins opt roles in
-- from ロール管理. Forward-only + idempotent via INSERT OR IGNORE (0003-0023 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','chat:manage_sections');
