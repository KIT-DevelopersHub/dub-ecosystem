// audit-log constants. Centralized so the retention window stays in lockstep with
// the conditional DELETE trigger in db/0001_audit_logs.sql.

export const SERVICE_NAME = "audit-log";

// D1 retention window (months). Rows older than this may be archived+deleted.
// P0b 9-C: tentative; final number decided at 9-E. MUST match the '-3 months' in
// the audit_logs_no_delete trigger.
export const RETENTION_MONTHS = 3;

// details JSON size cap (bytes) — theme#13: small JSON, no secrets.
export const MAX_DETAILS_BYTES = 8 * 1024;

// query paging (common.CursorQuery: default 50 / max 200).
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

// R2 archive key prefix.
export const ARCHIVE_PREFIX = "audit-archive";
