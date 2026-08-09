// D1 access for the audit namespace. Uses @dub/db DbClient (namespace-scoped,
// runtime-DDL-forbidden). Append-only by construction: only INSERT and SELECT here.
import { type DbClient, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { auditLog } from "@dub/types";

interface AuditRow {
  id: string;
  action: string;
  actor_id: string | null;
  org_id: string;
  result: string;
  resource_type: string | null;
  resource_id: string | null;
  request_id: string;
  occurred_at: string;
  recorded_at: string;
  details_json: string | null;
}

function rowToRecord(r: AuditRow): auditLog.AuditRecord {
  return {
    id: r.id,
    action: r.action,
    actorId: r.actor_id,
    orgId: r.org_id,
    result: r.result as auditLog.AuditResult,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    requestId: r.request_id,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    details: r.details_json ? (JSON.parse(r.details_json) as Record<string, unknown>) : null,
  };
}

function encodeCursor(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(cursor: string): string {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64);
  } catch {
    throw errors.validationFailed([{ field: "cursor", reason: "invalid_cursor" }]);
  }
}

/**
 * Append a record. id is producer-assigned (queue envelope id, or the sync caller's
 * idempotency key). INSERT OR IGNORE makes re-delivery / retry idempotent.
 * recorded_at is stamped app-side (nowIso; no DDL DEFAULT). Returns the id.
 */
export async function insertRecord(db: DbClient, id: string, input: auditLog.AuditRecordInput): Promise<string> {
  await db.run(
    `INSERT OR IGNORE INTO audit_logs
       (id, action, actor_id, org_id, result, resource_type, resource_id, request_id, occurred_at, recorded_at, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.action,
    input.actorId,
    input.orgId,
    input.result,
    input.resourceType,
    input.resourceId,
    input.requestId,
    input.occurredAt,
    nowIso(),
    input.details === null ? null : JSON.stringify(input.details),
  );
  return id;
}

export async function getById(db: DbClient, id: string): Promise<auditLog.AuditRecord | null> {
  const row = await db.first<AuditRow>(`SELECT * FROM audit_logs WHERE id = ?`, id);
  return row ? rowToRecord(row) : null;
}

/** Cursor-paginated search, newest first (id DESC ~ time DESC). */
export async function queryLogs(db: DbClient, q: auditLog.AuditLogQuery): Promise<auditLog.AuditLogPage> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (q.actorId !== undefined) { where.push("actor_id = ?"); binds.push(q.actorId); }
  if (q.action !== undefined) {
    // "deploy." (trailing dot) => prefix match; otherwise exact.
    if (q.action.endsWith(".")) { where.push("action LIKE ? ESCAPE '\\'"); binds.push(q.action.replace(/[%_\\]/g, "\\$&") + "%"); }
    else { where.push("action = ?"); binds.push(q.action); }
  }
  if (q.resourceType !== undefined) { where.push("resource_type = ?"); binds.push(q.resourceType); }
  if (q.resourceId !== undefined) { where.push("resource_id = ?"); binds.push(q.resourceId); }
  if (q.result !== undefined) { where.push("result = ?"); binds.push(q.result); }
  if (q.since !== undefined) { where.push("occurred_at >= ?"); binds.push(q.since); }
  if (q.until !== undefined) { where.push("occurred_at < ?"); binds.push(q.until); }
  if (q.cursor !== undefined) { where.push("id < ?"); binds.push(decodeCursor(q.cursor)); }

  const limit = q.limit ?? 50;
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ?`;
  const rows = await db.all<AuditRow>(sql, ...binds, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(rowToRecord);
  const last = page[page.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
}

/** Rows strictly older than the retention cutoff (for the monthly archive job). */
export async function selectBefore(db: DbClient, cutoffIso: string): Promise<auditLog.AuditRecord[]> {
  const rows = await db.all<AuditRow>(
    `SELECT * FROM audit_logs WHERE occurred_at < ? ORDER BY occurred_at ASC`,
    cutoffIso,
  );
  return rows.map(rowToRecord);
}

/**
 * Delete rows strictly older than the cutoff. Plain DML; the conditional
 * audit_logs_no_delete trigger physically rejects any row inside the retention
 * window, so this can never breach append-only. Returns rows deleted.
 */
export async function deleteBefore(db: DbClient, cutoffIso: string): Promise<number> {
  const res = await db.run(`DELETE FROM audit_logs WHERE occurred_at < ?`, cutoffIso);
  return res.meta.changes;
}

export { encodeCursor, decodeCursor };
