-- namespace: identity | owner: identity-roster (#3)
-- Additive grant for the new RBAC catalog key `notif:broadcast_publish` (packages/types
-- PERMISSION_CATALOG, 34 keys). It gates the Notification management screen: listing
-- admin-audience notifications and publishing one to all members as a broadcast.
--
-- Granted to `admin` (the super-admin invariant — admin holds EVERY catalog key, guarded
-- by seed.test.ts) and `maintainer` (a management tier that already holds notif:admin).
-- organizer/member intentionally do NOT get it — publishing to the whole org is an admin
-- action. Forward-only and idempotent via INSERT OR IGNORE; never edits the frozen 0002
-- seed (no ledger drift, per the 0003/0004/0005 convention).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','notif:broadcast_publish'),
  ('role_sys_maintainer','notif:broadcast_publish');
