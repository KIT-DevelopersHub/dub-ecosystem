// Dependency surface the service layer is written against. Concrete production
// wiring lives in sinks.ts / index.ts; tests inject fakes. Keeping side-effecting
// collaborators (audit, session revoke) behind interfaces is what lets the RBAC
// semantics be unit-tested without SES/Queue/auth being live (9-B/C/E pending).
import type { auditLog } from "@dub/types";
import type { IdentityRepo } from "./repo/types";

export interface RequestCtx {
  requestId: string;
  actorId: string | null;
}

export interface AuditSink {
  /** Synchronous write-ahead audit (SYNC_AUDIT_ACTIONS). MUST throw on failure
   *  so the caller can abort the mutation (fail-close, §4). */
  logSync(input: auditLog.AuditRecordInput): Promise<void>;
  /** Best-effort Queue audit (publishAudit). Never throws into business flow. */
  publish(input: auditLog.AuditRecordInput): Promise<void>;
}

export interface SessionRevoker {
  /** auth-service POST /internal/revoke-user. Throws on failure => suspend aborts. */
  revokeUser(userId: string, ctx: RequestCtx): Promise<void>;
}

export interface Deps {
  repo: IdentityRepo;
  audit: AuditSink;
  revoker: SessionRevoker;
  now: () => string; // @dub/db nowIso
  newId: (prefix: string) => string; // @dub/db newId
  defaultOrgId: string; // common.DUB_DEFAULT_ORG_ID
}
