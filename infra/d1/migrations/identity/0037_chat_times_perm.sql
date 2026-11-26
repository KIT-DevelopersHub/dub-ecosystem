-- namespace: identity | owner: identity-roster (#3)
-- チャット の「times を作成」(#850) にカタログキーを 1 本足す:
--   chat:times  (/chat/times/* — dry-run プレビュー / まとめて作成。Dub チャット内のチャンネル)
-- Default: ON for the system admin role only (super-admin invariant role_sys_admin ⊇
-- PERMISSION_CATALOG). Other roles start OFF; admins opt roles in from ロール管理.
-- 自動適用されない。デプロイ前に手で当てること。Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','chat:times');
