-- namespace: identity | owner: identity-roster (#3)
-- Root-cause fill (prod incident 2026-08-15): the frozen 0002 seed shipped the `admin`
-- role below the frozen RBAC catalog (packages/types PERMISSION_CATALOG, 33 keys). Earlier
-- forward-only grants patched single holes as they surfaced (0003 mail:read_all, 0004
-- notif self-service). This closes EVERY remaining gap in one shot so `admin` holds the
-- complete catalog — the super-admin invariant is now guarded by infra/d1 seed.test.ts.
--   * github:* (github-sync) + webhook:read (webhook-ingest): admin admin/action surfaces
--     that 0002 never granted admin -> "権限がありません" on those pages.
--   * drive:read / drive:write: prod was hotfixed manually but the committed migration
--     source never carried them (the fix lived in an un-merged file), so every fresh /
--     preview DB rebuilt admin WITHOUT drive:* — classic seed drift. Reproduce it here.
-- Forward-only and idempotent via INSERT OR IGNORE; never edits the frozen 0002 seed
-- (no ledger drift). On prod the drive:* rows already exist -> no-op there. Only admin
-- gets these:
--   * maintainer already has github:read/write/sync + drive:* + webhook:read (0002); it
--     intentionally stays WITHOUT github:admin (dangerous integration admin = org-admin tier).
--   * organizer/member stay scoped-minimal (no github/drive/webhook admin surface).
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','github:read'),
  ('role_sys_admin','github:write'),
  ('role_sys_admin','github:sync'),
  ('role_sys_admin','github:admin'),
  ('role_sys_admin','webhook:read'),
  ('role_sys_admin','drive:read'),
  ('role_sys_admin','drive:write');
