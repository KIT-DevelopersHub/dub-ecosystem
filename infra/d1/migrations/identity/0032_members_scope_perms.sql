-- namespace: identity | owner: identity-roster (#3)
-- 運営メンバーアプリの範囲 (組織図まで / メール名簿以外 / 全て) のカタログキー 4 本:
--   members:roster_view / members:roster_edit  (運営名簿タブ・個人情報の閲覧と編集)
--   members:mail_view   / members:mail_edit    (メール名簿タブの閲覧と編集)
-- 今できることに合わせて付与する。運営メンバーの範囲に移るので、運営メンバーの権限が足りないロールは
-- メール名簿から外れる (ロール管理の権限だけで開けていた分)。
--   運営名簿 = app:members:* を持つロール全部 (これまで同じゲートだった)
--   メール名簿 = 閲覧は app:members:view + app:admin:view + identity:read、
--               編集は app:members:edit + app:admin:edit + identity:admin
-- 自動適用されない (deploy.yml の migration は no-op)。デプロイ前に手で当てること。未適用だと admin を含む
-- 全ロールが 組織図まで に落ちる。
-- 新しく作るロールには付かない = 既定は 組織図まで。Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'members:roster_view' FROM identity_role_permissions WHERE permission_key = 'app:members:view';
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'members:roster_edit' FROM identity_role_permissions WHERE permission_key = 'app:members:edit';

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT v.role_id, 'members:mail_view' FROM identity_role_permissions v
  WHERE v.permission_key = 'app:members:view'
    AND v.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'app:admin:view')
    AND v.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'identity:read');
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT e.role_id, 'members:mail_edit' FROM identity_role_permissions e
  WHERE e.permission_key = 'app:members:edit'
    AND e.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'app:admin:edit')
    AND e.role_id IN (SELECT role_id FROM identity_role_permissions WHERE permission_key = 'identity:admin');

-- mail_edit ⇒ mail_view (normalizeAppAccessKeys と同じ不変条件)。
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'members:mail_view' FROM identity_role_permissions WHERE permission_key = 'members:mail_edit';

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','members:roster_view'),('role_sys_admin','members:roster_edit'),
  ('role_sys_admin','members:mail_view'),('role_sys_admin','members:mail_edit');
