-- namespace: identity | owner: identity-roster (#3)
-- Additive grant for the new RBAC catalog key `usage:view` (packages/types
-- PERMISSION_CATALOG, 35 keys). It backs the 使用量 app (無料枠 / 課金ガード dashboard,
-- /usage) so the app becomes representable/toggleable in FE7's role matrix — closing the
-- per-app-permission 抜け漏れ (previously the usage app had NO catalog key at all).
--
-- Granted to ALL four system roles: the usage dashboard is a safe D1 snapshot shown to
-- every signed-in user today (the FE nav has no gate and usage-meter requires auth only).
-- Granting it to admin/maintainer/organizer/member preserves that "everyone signed in
-- sees usage" parity now that the key exists (so a system-role holder is never worse off).
-- admin also holds it via the super-admin invariant (seed.ts ALL_KEYS / seed.test.ts).
-- Forward-only and idempotent via INSERT OR IGNORE; never edits the frozen 0002 seed
-- (no ledger drift, per the 0003/0004/0005/0006 convention).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','usage:view'),
  ('role_sys_maintainer','usage:view'),
  ('role_sys_organizer','usage:view'),
  ('role_sys_member','usage:view');
