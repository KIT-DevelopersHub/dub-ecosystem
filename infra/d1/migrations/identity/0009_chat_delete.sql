-- namespace: identity | owner: identity-roster (#3)
-- Additive grant for the new RBAC catalog key `chat:delete` (packages/types
-- PERMISSION_CATALOG). Deleting one's OWN chat message used to be universal for any
-- author; it is now gated on `chat:delete` so a role can be set to 削除権限なし. Granting it
-- to ALL four system roles preserves the pre-gate ability (nobody loses own-delete on
-- rollout) — every system role already holds chat:create (can use chat). admin also holds
-- it via the super-admin invariant (seed.ts ALL_KEYS / seed.test.ts). complex delete of
-- OTHERS' messages stays on chat:moderate (unchanged). Forward-only + idempotent via
-- INSERT OR IGNORE; never edits the frozen 0002 seed (no ledger drift, per the
-- 0003–0008 convention).
--
-- Production rollout ordering: apply this BEFORE / WITH the chat-service delete-gate
-- deploy so authors never briefly lose own-delete while the gate is live but ungranted.
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','chat:delete'),
  ('role_sys_maintainer','chat:delete'),
  ('role_sys_organizer','chat:delete'),
  ('role_sys_member','chat:delete');
