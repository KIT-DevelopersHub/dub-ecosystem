-- namespace: identity | owner: identity-roster (#3)
-- Additive: provenance of each role assignment. 'manual' = granted by an admin (ロール管理),
-- 'auto:member-sync' = granted by member-service from the 名簿 (所属チーム / 役職). The sync
-- (PUT /internal/users/:id/managed-roles) only adds/removes rows it owns, so manual grants are
-- never touched. Auto rows stay org-wide (resource_type/resource_id NULL) so they count for
-- permissions, mail visibility and role peers exactly like a manual grant.
-- Existing rows backfill to 'manual' (literal DEFAULT is allowed by D2).
-- D1 has no "ADD COLUMN IF NOT EXISTS": apply only where the column is absent.
-- Physical twin of ASSIGNMENT_SOURCE_UP in services/identity-roster/src/schema.ts.
ALTER TABLE identity_role_assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','auto:member-sync'));
