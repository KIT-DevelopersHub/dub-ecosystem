-- namespace: identity | owner: identity-roster (#3)
-- Additive grant: give EVERY system role the self-service notification permissions
-- `notif:inbox:self` (read/manage one's OWN inbox) and `notif:prefs:self` (manage one's
-- OWN notification preferences). These are per-user self-service scopes every signed-in
-- member inherently holds, but the frozen 0002 seed never granted them to any role.
--
-- PROD INCIDENT (2026-08-15): the FE5 notifications module gates the inbox page
-- (/notifications) on `notif:inbox:self` and the preferences page
-- (/settings/notifications) on `notif:prefs:self` (composition/featureModules.tsx +
-- fe5 routes.ts). With no role granting either, EVERY real user — admins included —
-- got the 403 "権限がありません" screen on 通知一覧, i.e. "通知が見られない". The demo/E2E
-- never caught it because DEMO_PERMISSIONS hard-codes both self perms (demo-seed.tsx),
-- so only real role-derived sessions hit the gap.
--
-- Forward-only and idempotent via INSERT OR IGNORE; never edits the frozen 0002 seed
-- (no ledger drift, per 0003's convention). Granted to all four system roles because a
-- user always owns their own inbox + preferences regardless of tier.
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','notif:inbox:self'),      ('role_sys_admin','notif:prefs:self'),
  ('role_sys_maintainer','notif:inbox:self'), ('role_sys_maintainer','notif:prefs:self'),
  ('role_sys_organizer','notif:inbox:self'),  ('role_sys_organizer','notif:prefs:self'),
  ('role_sys_member','notif:inbox:self'),     ('role_sys_member','notif:prefs:self');
