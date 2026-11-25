-- namespace: identity | owner: identity-roster (#3)
-- 代理表示 (admin impersonation / 「このメンバーとして表示」) のカタログキー 1 本:
--   identity:impersonate  (他メンバーとしてアプリを表示する短時間・監査付きセッションを開始できる)
-- 既定では role_sys_admin にだけ付与する (super-admin 不変条件 role_sys_admin ⊇ PERMISSION_CATALOG)。
-- このキーを持つメンバーは代理表示の対象にできない (admin→admin の昇格を防ぐ・auth-service が判定)。
-- 他ロールへはロール管理から明示的にオンにする。Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','identity:impersonate');
