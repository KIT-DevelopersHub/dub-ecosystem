-- namespace: identity | owner: identity-roster (#3)
-- チャット の「Slack の絵文字を取り込み」gets its own toggle in ロール管理 > チャット > 細かい権限,
-- backed by a new catalog key:
--   chat:emoji_import  (POST /chat/custom-emojis/slack-import — Slack custom emoji -> R2)
-- Default: ON for the system admin role only (also the super-admin invariant
-- role_sys_admin ⊇ PERMISSION_CATALOG). Every other role starts OFF — admins opt roles in
-- from ロール管理. Forward-only + idempotent via INSERT OR IGNORE (0003-0022 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','chat:emoji_import');
