-- audit-log namespace (#10). Semantic source of truth; physical copy lives in
-- infra/d1/migrations/audit/ (owned by #28) which imports this verbatim.
-- Binding: shared DB (dub-core). Namespace prefix: audit_ .
-- Columns mirror @dub/types auditLog.AuditRecord exactly (frozen contract:
-- actorId|orgId|result|resourceType|resourceId|details|requestId|occurredAt + id|recordedAt).
-- No DDL DEFAULT (D2): recorded_at is app-side nowIso(). id = producer bare ULID (no prefix; D1 exception).

CREATE TABLE audit_logs (
  id             TEXT PRIMARY KEY,            -- bare ULID (producer-assigned; time-sortable)
  action         TEXT NOT NULL,               -- "<domain>.<entity>.<verb>" (open vocabulary)
  actor_id       TEXT,                        -- NULL = system actor
  org_id         TEXT NOT NULL,
  result         TEXT NOT NULL CHECK (result IN ('success','failure','denied','intent')),
  resource_type  TEXT,
  resource_id    TEXT,
  request_id     TEXT NOT NULL,               -- x-dub-request-id (correlation)
  occurred_at    TEXT NOT NULL,               -- ISO 8601 UTC (producer clock)
  recorded_at    TEXT NOT NULL,               -- ISO 8601 UTC, audit-log clock (nowIso())
  details_json   TEXT                         -- JSON string, secrets stripped, <= 8KB
);

CREATE INDEX idx_audit_logs_actor    ON audit_logs (actor_id, id);
CREATE INDEX idx_audit_logs_resource ON audit_logs (resource_type, resource_id, id);
CREATE INDEX idx_audit_logs_action   ON audit_logs (action, id);
CREATE INDEX idx_audit_logs_org      ON audit_logs (org_id, id);
CREATE INDEX idx_audit_logs_occurred ON audit_logs (occurred_at);

-- Append-only: UPDATE is fully forbidden.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- DELETE forbidden inside the retention window; rows older than the boundary may be
-- deleted by the monthly R2 archive job using plain DML (no runtime DDL / DROP TRIGGER).
-- NOTE (P0b 9-C): retention number is tentative. Keep this '-3 months' in lockstep with
-- RETENTION_MONTHS in src/config.ts; final value set by the 9-E cost decision.
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
WHEN OLD.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 months')
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only within retention window'); END;
