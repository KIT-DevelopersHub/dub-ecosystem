-- namespace: identity | owner: identity-roster (#3)
-- ガント/タスクの「すべてのタスクを編集」(#881) にカタログキーを 1 本足す:
--   task:edit_all  (持っていないと task:write があっても、担当が個人ならその本人だけ、担当がチーム
--                   ならそのチームのメンバー、担当なしなら作成者だけが編集できる)
-- 最初から持つのは admin と maintainer だけ (オーナー決定)。organizer・カスタムロールには付けない
-- (チーム担当のタスクはそのチームのメンバーが編集できる)。
--   - role_sys_admin (super-admin invariant: role_sys_admin ⊇ PERMISSION_CATALOG)
--   - role_sys_maintainer
-- 必要なロールにはロール管理 > マイタスク > 詳細で ON にする。
-- 自動適用されない (deploy.yml の migration は no-op)。デプロイ前に手で当てること。未適用だと admin を
-- 含む全ロールが「自分 (or 自分のチーム) が担当/担当なしで自分が作成したタスクだけ」編集できる状態になる。
-- Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','task:edit_all'),
  ('role_sys_maintainer','task:edit_all');
