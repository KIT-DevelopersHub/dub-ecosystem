-- namespace: identity | owner: identity-roster (#3)
-- Additive: provenance of each user row ('manual' | 'email-routing') for the Email Routing
-- roster sync. Physical twin of SOURCE_UP in services/identity-roster/src/schema.ts, which
-- only the code-side IDENTITY_MIGRATIONS carried — so the remote schema gate could not see
-- it and staging ran without the column. Literal DEFAULT (not datetime) is allowed by D2.
-- D1 has no "ADD COLUMN IF NOT EXISTS": apply only where the column is absent.
ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','email-routing'));
