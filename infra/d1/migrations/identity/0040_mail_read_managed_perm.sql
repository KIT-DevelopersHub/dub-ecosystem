-- namespace: identity | owner: identity-roster (#3)
-- `mail:read_managed` (#942): a leader reads the mail of their 班's members, an organizer the
-- mail of their team's members — read-only, and only that range (mail-gateway asks
-- member-service who is in it on every request). Added to PERMISSION_CATALOG, so the
-- super-admin invariant (admin ⊇ PERMISSION_CATALOG) requires role_sys_admin to hold it.
-- NO other role is granted it: it is turned on per role in ロール管理 > メール 詳細設定
-- (e.g. on 役職: リーダー / 役職: オーガナイザー). Forward-only + idempotent (INSERT OR IGNORE).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','mail:read_managed');
