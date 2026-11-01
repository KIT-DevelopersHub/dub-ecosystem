-- namespace: identity | owner: identity-roster (#3)
-- 人事アプリ (面談 → 採用 → オンボーディング, member-service /members/hr/*) の
-- ロール管理項目。新しいカタログキー 5 本:
--   app:hr:view / app:hr:edit  (人事アプリの 無効/閲覧/編集)
--   hr:read   (応募者・履歴・オンボーディング進捗の閲覧 — 個人情報)
--   hr:write  (応募者登録・ステータス変更・面談日/メモ・オンボーディングのチェック)
--   hr:admin  (採用 = 名簿への追加 / 応募者の削除)
-- 人事はまだメンバー未公開 (fe2 releaseGate PUBLISHED_APPS 外) なので、既定では
-- role_sys_admin にだけ付与する (super-admin 不変条件 role_sys_admin ⊇ PERMISSION_CATALOG)。
-- 他ロールはロール管理から明示的にオンにする。Forward-only + idempotent (INSERT OR IGNORE)。

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:hr:view'),('role_sys_admin','app:hr:edit'),
  ('role_sys_admin','hr:read'),('role_sys_admin','hr:write'),('role_sys_admin','hr:admin');
