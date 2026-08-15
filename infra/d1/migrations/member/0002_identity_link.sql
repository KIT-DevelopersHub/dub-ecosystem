-- namespace: member | owner: member-service (運営メンバー管理)
-- Link a 運営メンバー row to its identity-roster login account (RBAC の真実との橋渡し).
-- Additive, forward-only. Bridges the two sources of truth: member_people is the
-- 組織図 (team / role_title), identity_users is the account / RBAC. Without this line a
-- person is registered twice with no relation, so a roster user disabled on the RBAC
-- side silently stays "在籍" here. `identity_user_id` is the identity userId (opaque
-- string; NOT a cross-namespace FK — theme-3 keeps ids as strings, integration via API).
--   NULL          : not yet linked (all existing rows backfill to NULL — no data loss).
--   <identity id> : this person IS that login account. The link is confirmed by a human
--                   (name-match candidates are only a hint); auto-linking is avoided.
-- No timestamp DEFAULT (theme-3 D2). ADD COLUMN only (D1 has no "ADD COLUMN IF NOT
-- EXISTS"), matching the mail 0006 / identity 0003 style.
ALTER TABLE member_people ADD COLUMN identity_user_id TEXT;

-- Reverse lookup (find the member linked to an identity user, e.g. offboarding fan-out).
-- Partial index: only linked rows are indexed, so the common NULL rows cost nothing.
CREATE INDEX IF NOT EXISTS idx_member_people_identity
  ON member_people(identity_user_id) WHERE identity_user_id IS NOT NULL;
