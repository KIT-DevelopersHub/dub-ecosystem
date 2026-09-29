-- namespace: identity | owner: identity-roster (#3)
-- Per-app access grant for the Commander app. `app:commander:view` / `app:commander:edit`
-- were added to the frozen PERMISSION_CATALOG (packages/types identity.ts) when Commander
-- was registered as an RBAC-governed app, but no migration granted them — so
-- role_sys_admin was left WITHOUT the pair: the super-admin invariant (infra/d1 seed test:
-- admin ⊇ frozen PERMISSION_CATALOG) fails and /commander would 403 for EVERYONE,
-- including admin. Same 抜け as 0011 (カレンダー).
--
-- Commander is ADMIN-ONLY (its fe2 module gates on identity:admin and it is absent from
-- releaseGate PUBLISHED_APPS, so no member role reaches it). Matching 0009/0011's admin
-- block, only role_sys_admin is granted here. Forward-only + idempotent via
-- INSERT OR IGNORE; never edits the frozen 0002 seed (0003-0011 convention).

INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','app:commander:view'),('role_sys_admin','app:commander:edit');
