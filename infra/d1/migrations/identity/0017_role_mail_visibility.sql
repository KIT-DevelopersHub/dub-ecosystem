-- namespace: identity | owner: identity-roster (#3)
-- Cross-role mail visibility: holders of `role_id` (org-wide) also see the INBOUND mail of
-- the org-wide holders of `target_role_id`. Directional (統括 -> 全ロール does not grant the
-- reverse). Complements `mail:read_role_shared` (same-role, mutual), which stays a permission
-- key. Edited per role in ロール管理 > メール 詳細設定. Forward-only, additive, no datetime
-- DEFAULTs (D2). Both columns cascade so deleting either role drops the row.

CREATE TABLE IF NOT EXISTS identity_role_mail_visibility (
  role_id        TEXT NOT NULL REFERENCES identity_roles(id) ON DELETE CASCADE,
  target_role_id TEXT NOT NULL REFERENCES identity_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, target_role_id),
  CHECK (role_id <> target_role_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_role_mail_visibility_target
  ON identity_role_mail_visibility (target_role_id);
