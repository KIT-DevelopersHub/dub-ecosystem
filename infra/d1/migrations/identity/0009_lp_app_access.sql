-- namespace: identity | owner: identity-roster (#3)
-- Per-app access grant for the LP管理 app (PR #470). The app was added AFTER 0008
-- backfilled the per-app tier, so 0008 could not grant its keys and role_sys_admin was
-- left WITHOUT app:lp:view / app:lp:edit — the launcher showed the LP管理 tile but greyed,
-- and /lp 403'd for EVERYONE including admin (the 抜け: catalog key added, no role grant).
--
-- LP管理 is an ADMIN-ONLY app in this release (not member-published; see fe2
-- releaseGate PUBLISHED_APPS, and identity-roster seed.ts APP_ACCESS_RULES has no "lp"
-- rule → no non-admin role reaches it). So, matching the super-admin invariant
-- (seed.ts: admin holds ALL per-app keys / allAppAccessKeys) and 0008's admin block,
-- only role_sys_admin is granted the LP pair here. Forward-only + idempotent via
-- INSERT OR IGNORE; never edits the frozen 0002 seed (0003–0008 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:lp:view'),('role_sys_admin','app:lp:edit');
