-- namespace: identity | owner: identity-roster (#3)
-- 通知の「誰に届くか」をロール管理で決められるようにする。2 つの新しいカタログキー:
--   notif:receive_admin  「管理者向け通知を受け取る」 (デプロイ完了・問い合わせ/フィードバック・参加届・
--                         死活監視/無料枠/メール配信アラート・GitHub/DNS)
--   notif:receive_all    「全体への通知を受け取る」   (お知らせ・リリースノート・管理画面から公開した通知)
-- notification-service は宛先を「そのキーを持つロールのユーザー」として解決する
-- (identity GET /internal/permission-holders)。以前はハードコードのロール
-- (role_sys_admin / role_sys_maintainer) と notif:admin (受信箱の管理者判定) で決まっていた。
--
-- NON-BREAKING BACKFILL — デプロイ後も今と同じ人に同じ通知が届くように付与する:
--   (A) admin は全カタログキーを持つ (super-admin invariant, seed.test.ts)。
--   (B) 管理者向け通知は今「notif:admin を持つロール」(受信箱の管理者判定) と、ハードコード宛先の
--       role_sys_admin / role_sys_maintainer に届いている → その全ロールに receive_admin。
--       SELECT 駆動なのでカスタムロールも含む。
--   (C) 全体への通知は今「アクティブな全ユーザー」に届いている。受信箱を開けるのは 通知 アプリが
--       閲覧以上のロールを持つ人だけなので、app:notifications:view を持つ全ロールに receive_all
--       (名簿同期の role_auto_* 権限なしロールは対象外になる)。
-- Forward-only + idempotent (INSERT OR IGNORE)。凍結済みの 0002 seed は触らない (0003-0027 と同じ)。
-- 既存キー (notif:send / notif:inbox:self / notif:prefs:self) は削除しない: ロール管理の表示から
-- 外すだけ (policy.HIDDEN_PERMISSION_KEYS)。カタログは凍結契約で、行を残しても害はない。

-- (A) super-admin invariant
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','notif:receive_admin'),
  ('role_sys_admin','notif:receive_all');

-- (B) 管理者向け通知: 今それを受け取っているロール
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_maintainer','notif:receive_admin');
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'notif:receive_admin' FROM identity_role_permissions WHERE permission_key = 'notif:admin';

-- (C) 全体への通知: 通知 アプリを開ける全ロール
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key)
  SELECT role_id, 'notif:receive_all' FROM identity_role_permissions WHERE permission_key = 'app:notifications:view';
