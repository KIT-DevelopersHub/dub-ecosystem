-- namespace: identity | owner: identity-roster (#3)
-- ガント/タスクの「すべてのタスクを編集」(#881) にカタログキーを 1 本足す:
--   task:edit_all  (持っていないと task:write があっても、自分が担当か自分が作成したタスクだけ編集できる)
-- 今すべてのタスクを編集している運営側のロールが困らないように、次のロールへ付ける:
--   - role_sys_admin (super-admin invariant: role_sys_admin ⊇ PERMISSION_CATALOG)
--   - task:delete を持つロール (role_sys_maintainer / role_sys_organizer と、それを付けたカスタムロール)
--   - event:write を持つロール (イベントを運営する側。統括・リーダー等のカスタムロール)
-- role_sys_member (task:write のみ) には付けない = 一般メンバーは自分のタスクだけ編集できるようになる (#881 の目的)。
-- 自動適用されない (deploy.yml の migration は no-op)。デプロイ前に手で当てること。未適用だと admin を
-- 含む全ロールが「担当/作成したタスクだけ」編集できる状態になる。
-- Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','task:edit_all');

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT DISTINCT role_id, 'task:edit_all' FROM identity_role_permissions
  WHERE permission_key IN ('task:delete', 'event:write');
