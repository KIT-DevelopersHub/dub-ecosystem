-- namespace: identity | owner: identity-roster (#3)
-- Additive grant: give the system `admin` role the new `mail:read_all` permission
-- (mail oversight — view every user's mail, incl. the archive mailbox). Forward-only and
-- idempotent via INSERT OR IGNORE; never edits the frozen 0002 seed (no ledger drift).
-- Only admin gets it here; maintainer/organizer/member keep own-mail scope (mail:read).
-- The info@ / admin@ oversight accounts inherit it through their admin role assignment.
INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) VALUES
  ('role_sys_admin','mail:read_all');
