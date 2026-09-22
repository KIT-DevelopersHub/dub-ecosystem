-- namespace: identity | owner: identity-roster (#3)
-- Per-app access grant for the カレンダー app (PR #542). The app was added AFTER 0008
-- backfilled the per-app tier and after 0009 (LP), so no prior migration granted its
-- keys and role_sys_admin was left WITHOUT app:calendar:view / app:calendar:edit — the
-- super-admin invariant (infra/d1 seed test: admin ⊇ frozen PERMISSION_CATALOG) fails,
-- and /calendar would 403 for EVERYONE including admin (the 抜け: catalog key added in
-- packages/types identity.ts, no role grant).
--
-- カレンダー is an ADMIN-ONLY app in this release (not member-published; see fe2
-- releaseGate PUBLISHED_APPS which stays ["mail"], and identity-roster seed.ts
-- APP_ACCESS_RULES has no "calendar" rule → no non-admin role reaches it). So, matching
-- the super-admin invariant and 0009's admin block, only role_sys_admin is granted the
-- calendar pair here. Forward-only + idempotent via INSERT OR IGNORE; never edits the
-- frozen 0002 seed (0003–0009 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:calendar:view'),('role_sys_admin','app:calendar:edit');
