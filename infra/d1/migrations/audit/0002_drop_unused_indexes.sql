-- #841: cut audit_logs write amplification. Each INSERT wrote the table + PK autoindex +
-- 5 secondary indexes (~7 rows written); the 2026-11-25 outbox backlog flush pushed dub-core
-- to 96% of the D1 Free plan's 100k rows-written/day. Drop the indexes no real query needs
-- (-> ~4 rows per INSERT). Kept: idx_audit_logs_actor (FE7 actor filter) and
-- idx_audit_logs_action (FE7 exact-action filter). Reads fall back to the PK (ULID = time
-- order) scan, which is cheap on a 3-month-retention table. Idempotent (IF EXISTS).
DROP INDEX IF EXISTS idx_audit_logs_org;      -- no query filters by org_id
DROP INDEX IF EXISTS idx_audit_logs_resource; -- no caller sends resourceType/resourceId
DROP INDEX IF EXISTS idx_audit_logs_occurred; -- since/until + monthly archive only; PK scan suffices
