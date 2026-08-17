// auditLog — audit-log namespace. Owns AuditRecordInput + SYNC_AUDIT_ACTIONS.
import type { AuditLogId, UserId, OrgId, ISODateTime, Paginated, CursorQuery } from "./common";

export type AuditResult = "success" | "failure" | "denied" | "intent";

export interface AuditRecordInput {
  action: string; // "<domain>.<entity>.<verb>" (open vocabulary)
  actorId: UserId | null; // null = system
  orgId: OrgId;
  result: AuditResult;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null; // secrets stripped by publishAudit sanitizer
  requestId: string;
  occurredAt: ISODateTime;
}

export interface AuditRecord extends AuditRecordInput {
  id: AuditLogId;
  recordedAt: ISODateTime;
}

export interface AuditLogWriteResponse {
  id: AuditLogId;
}

export interface AuditLogQuery extends CursorQuery {
  actorId?: UserId;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: AuditResult;
  since?: ISODateTime;
  until?: ISODateTime;
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* audit-log's read endpoint puts
// on the wire. The server (audit-log validation.ts parseAuditLogQuery) and the OpenAPI
// spec (docs/openapi/audit-log.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). Renaming a key here is the only legitimate way to
// change a wire param. See docs/api-contracts/_wire-contract-enforcement.md.
export const AUDIT_LOG_WIRE = {
  queryAuditLog: {
    method: "GET",
    path: "/audit/logs",
    query: ["cursor", "limit", "actorId", "action", "resourceType", "resourceId", "result", "since", "until"],
  },
} as const;

// Compile-time tie: every query key the descriptor lists must be a real key of the typed
// query interface, so the descriptor and the type can never silently drift.
type _AuditLogWireKeysAreTyped =
  (typeof AUDIT_LOG_WIRE)[keyof typeof AUDIT_LOG_WIRE]["query"][number] extends keyof AuditLogQuery
    ? true
    : never;
const _auditLogWireKeyGuard: _AuditLogWireKeysAreTyped = true;
void _auditLogWireKeyGuard;
export type AuditLogPage = Paginated<AuditRecord>;

// Closed catalog of the 5 actions that MUST use synchronous POST /internal/log
// (deploy + identity permission changes). Anything else uses Queue publishAudit.
export const SYNC_AUDIT_ACTIONS = [
  "infra.deploy.executed",
  "infra.dns.changed",
  "identity.role.assigned",
  "identity.role.revoked",
  "identity.user.provisioned",
] as const;
export type SyncAuditAction = (typeof SYNC_AUDIT_ACTIONS)[number];
