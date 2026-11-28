-- namespace: identity | owner: identity-roster (#3)
-- 会計アプリ (団体の発行者情報, member-service /members/accounting/issuer) のロール管理項目。
-- 新しいカタログキー 3 本: app:accounting:view / app:accounting:edit / accounting:read。
-- まだメンバー未公開 (fe2 releaseGate PUBLISHED_APPS 外) なので、既定では role_sys_admin にだけ
-- 付与する (super-admin 不変条件 role_sys_admin ⊇ PERMISSION_CATALOG)。Forward-only + idempotent。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:accounting:view'),('role_sys_admin','app:accounting:edit'),('role_sys_admin','accounting:read');
