-- namespace: identity | owner: identity-roster (#3)
-- 目標管理アプリ (チームの月間目標と KPI, member-service /members/goals) のロール管理項目。
-- 新しいカタログキー 3 本: app:goals:view / app:goals:edit / goals:read。
-- まだメンバー未公開 (fe2 releaseGate PUBLISHED_APPS 外) なので、既定では role_sys_admin にだけ
-- 付与する (super-admin 不変条件 role_sys_admin ⊇ PERMISSION_CATALOG)。Forward-only + idempotent。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:goals:view'),('role_sys_admin','app:goals:edit'),('role_sys_admin','goals:read');
