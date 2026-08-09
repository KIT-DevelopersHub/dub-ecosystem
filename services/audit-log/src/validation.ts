// Input validation adhering to @dub/types auditLog contracts. Hand-rolled (no zod
// dependency: @dub/types ships zod-free; keeping the service dependency-light avoids
// lockfile churn across the parallel unit build). Every check maps to a FieldError.
import { errors, type FieldError } from "@dub/errors";
import { auditLog, common } from "@dub/types";
import { MAX_DETAILS_BYTES, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./config";

const RESULTS: ReadonlySet<string> = new Set<auditLog.AuditResult>(["success", "failure", "denied", "intent"]);
const SYNC_ACTIONS: ReadonlySet<string> = new Set<string>(auditLog.SYNC_AUDIT_ACTIONS);

// "<domain>.<verb>" or deeper, dot-separated lowercase-ish tokens; open vocabulary.
const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function byteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** Validate an AuditRecordInput; throws VALIDATION_FAILED with all field errors. */
export function parseAuditRecordInput(body: unknown): auditLog.AuditRecordInput {
  const fe: FieldError[] = [];
  if (!isPlainObject(body)) throw errors.validationFailed([{ field: "(root)", reason: "invalid_type" }]);
  const b = body;

  const action = b.action;
  if (typeof action !== "string" || action.length === 0) fe.push({ field: "action", reason: "required" });
  else if (!ACTION_RE.test(action)) fe.push({ field: "action", reason: "invalid_format", message: "expected dot-separated domain.verb" });

  const actorId = b.actorId;
  if (!(actorId === null || typeof actorId === "string")) fe.push({ field: "actorId", reason: "invalid_type" });

  const orgId = b.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) fe.push({ field: "orgId", reason: "required" });

  const result = b.result;
  if (typeof result !== "string" || !RESULTS.has(result)) fe.push({ field: "result", reason: "invalid_enum" });

  const resourceType = b.resourceType;
  if (!(resourceType === null || typeof resourceType === "string")) fe.push({ field: "resourceType", reason: "invalid_type" });

  const resourceId = b.resourceId;
  if (!(resourceId === null || typeof resourceId === "string")) fe.push({ field: "resourceId", reason: "invalid_type" });

  const details = b.details;
  if (!(details === null || isPlainObject(details))) {
    fe.push({ field: "details", reason: "invalid_type" });
  } else if (details !== null && byteLength(details) > MAX_DETAILS_BYTES) {
    fe.push({ field: "details", reason: "too_large", message: `details must be <= ${MAX_DETAILS_BYTES} bytes` });
  }

  const requestId = b.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) fe.push({ field: "requestId", reason: "required" });

  const occurredAt = b.occurredAt;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) fe.push({ field: "occurredAt", reason: "invalid_datetime" });

  if (fe.length > 0) throw errors.validationFailed(fe);

  return {
    action: action as string,
    actorId: (actorId as string | null),
    orgId: orgId as common.OrgId,
    result: result as auditLog.AuditResult,
    resourceType: resourceType as string | null,
    resourceId: resourceId as string | null,
    details: (details as Record<string, unknown> | null),
    requestId: requestId as string,
    occurredAt: occurredAt as common.ISODateTime,
  };
}

/** Sync fail-close path: additionally reject actions outside the closed catalog. */
export function assertSyncAction(action: string): void {
  if (!SYNC_ACTIONS.has(action)) {
    throw errors.validationFailed(
      [{ field: "action", reason: "not_in_sync_catalog", message: `${action} must use Queue publishAudit, not POST /internal/log` }],
      "action is not a synchronous audit action",
    );
  }
}

/** Validate the audit-record queue envelope (special channel, not a DubEventEnvelope). */
export function parseAuditEnvelope(msg: unknown): { id: string; input: auditLog.AuditRecordInput } {
  if (!isPlainObject(msg) || msg.type !== "audit.record" || msg.version !== 1 || typeof msg.id !== "string") {
    throw errors.validationFailed([{ field: "(envelope)", reason: "invalid_envelope" }]);
  }
  return { id: msg.id, input: parseAuditRecordInput(msg.payload) };
}

// ---- query parsing (GET /audit/logs) ----

function optStr(v: string | undefined): string | undefined {
  return v === undefined || v === "" ? undefined : v;
}

export function parseAuditLogQuery(q: Record<string, string | undefined>): auditLog.AuditLogQuery {
  const fe: FieldError[] = [];
  const out: auditLog.AuditLogQuery = {};

  const actorId = optStr(q.actorId);
  if (actorId) out.actorId = actorId;
  const action = optStr(q.action);
  if (action) out.action = action;
  const resourceType = optStr(q.resourceType);
  if (resourceType) out.resourceType = resourceType;
  const resourceId = optStr(q.resourceId);
  if (resourceId) out.resourceId = resourceId;

  const result = optStr(q.result);
  if (result) {
    if (!RESULTS.has(result)) fe.push({ field: "result", reason: "invalid_enum" });
    else out.result = result as auditLog.AuditResult;
  }

  const since = optStr(q.since);
  if (since) {
    if (Number.isNaN(Date.parse(since))) fe.push({ field: "since", reason: "invalid_datetime" });
    else out.since = since;
  }
  const until = optStr(q.until);
  if (until) {
    if (Number.isNaN(Date.parse(until))) fe.push({ field: "until", reason: "invalid_datetime" });
    else out.until = until;
  }

  const cursor = optStr(q.cursor);
  if (cursor) out.cursor = cursor;

  const limitRaw = optStr(q.limit);
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) fe.push({ field: "limit", reason: "invalid_range" });
    else if (n > MAX_QUERY_LIMIT) fe.push({ field: "limit", reason: "too_large", message: `limit must be <= ${MAX_QUERY_LIMIT}` });
    else out.limit = n;
  }

  if (fe.length > 0) throw errors.validationFailed(fe);
  if (out.limit === undefined) out.limit = DEFAULT_QUERY_LIMIT;
  return out;
}
