-- namespace: identity | owner: identity-roster (#3)
-- スポンサーアプリ (スポンサーチーム向け・フェーズ1 = 名刺の共有, member-service
-- /members/sponsor/*) のロール管理項目。新しいカタログキー 5 本:
--   app:sponsor:view / app:sponsor:edit  (スポンサーアプリの 無効/閲覧/編集)
--   sponsor:read   (共有された名刺の閲覧 — 個人情報)
--   sponsor:write  (名刺の登録 (撮影)・連絡先/メモの編集)
--   sponsor:admin  (名刺の削除)
-- まだメンバー未公開 (fe2 releaseGate PUBLISHED_APPS 外) なので、既定では role_sys_admin に
-- だけ付与する (super-admin 不変条件 role_sys_admin ⊇ PERMISSION_CATALOG)。スポンサーチームの
-- 自動ロールなど他ロールはロール管理から明示的にオンにする。Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:sponsor:view'),('role_sys_admin','app:sponsor:edit'),
  ('role_sys_admin','sponsor:read'),('role_sys_admin','sponsor:write'),('role_sys_admin','sponsor:admin');
