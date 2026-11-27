-- GET /internal/permission-holders (notification audience fan-out) counts members only for the
-- roles carrying the key; without a role_id index each count scanned every assignment. Additive.
CREATE INDEX IF NOT EXISTS idx_identity_role_assignments_role ON identity_role_assignments(role_id, org_id, user_id);
