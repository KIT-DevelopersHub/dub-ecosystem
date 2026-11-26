-- namespace: identity | owner: identity-roster (#3)
-- LP管理の詳細設定に「チケットの当日受付」のカタログキーを 1 本足す:
--   lp:checkin  (lp-tickets POST /lp/tickets/checkin・DELETE /lp/tickets/checkin/:ticketId・GET /lp/tickets/checkins)
-- 当日、受付係がスマホで LP管理 > チケット > 受付 を開き、参加者の QR を読んで受付済みにする。
-- 購入者一覧（app:lp:edit）を渡さずに受付だけを任せるための鍵（app:lp:view と組み合わせて使う）。
-- 付与は super-admin 不変条件の分だけ。受付係のロールへの付与は ロール管理 で選ぶ（ここでは広げない）。
-- 自動適用されない（deploy.yml の migration は no-op）。デプロイ前に手で当てること。未適用だと
-- admin を含む全ロールで受付タブが 403 になる。
-- Forward-only + idempotent (INSERT OR IGNORE)。

-- super-admin 不変条件 (role_sys_admin ⊇ PERMISSION_CATALOG)。
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','lp:checkin');
