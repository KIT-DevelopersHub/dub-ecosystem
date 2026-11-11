-- namespace: identity | owner: identity-roster (#3)
-- 運営メンバーの詳細設定に「参加届からのアカウント発行」のカタログキーを 1 本足す:
--   members:onboard_mail  (api-gateway POST /api/v1/admin/participation/:id/onboard-account)
-- 参加届の一覧で、まだアカウントの無い人にアドレス発行 + アカウント作成 (一般メンバー固定) +
-- 名簿との紐付け + 案内メールを 1 回で行う。人事に identity:admin / mail:admin / ロール管理の
-- 編集を渡さずに済ませるための鍵。
-- 今これができている人 (5 条件をすべて持つロール) はそのまま使えるように付与する。人事などへの
-- 付与は ロール管理 で選ぶ (ここでは広げない)。
-- 自動適用されない (deploy.yml の migration は no-op)。デプロイ前に手で当てること。未適用だと
-- admin を含む全ロールで参加届一覧の「メールアドレスも発行しますか？」が出なくなる。
-- Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT r.role_id, 'members:onboard_mail' FROM identity_role_permissions r
  WHERE r.permission_key = 'identity:admin'
    AND r.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'app:admin:edit')
    AND r.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'app:members:edit')
    AND r.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'members:mail_edit')
    AND r.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'mail:admin');

-- super-admin 不変条件 (role_sys_admin ⊇ PERMISSION_CATALOG)。
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','members:onboard_mail');
