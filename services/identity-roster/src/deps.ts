// Dependency surface the service layer is written against. Concrete production
// wiring lives in sinks.ts / index.ts; tests inject fakes. Keeping side-effecting
// collaborators (audit, session revoke) behind interfaces is what lets the RBAC
// semantics be unit-tested without SES/Queue/auth being live (9-B/C/E pending).
import type { auditLog, identity } from "@dub/types";
import type { IdentityRepo } from "./repo/types";
import type { WebauthnRepo } from "./repo/webauthn";

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

/** One user's role membership changed. drive-share-service follows it (Drive共有 grants and
 *  ミーティング invitations of those roles reach / leave the user). */
export interface RoleMembershipNotice {
  orgId: string;
  userId: string;
  change: identity.RoleMembershipChange;
  roleIds: string[];
  reason: identity.RoleMembershipReason;
}

export interface RoleMembershipSink {
  /** Best-effort (an outbox row): never throws into the business flow. A lost notice is caught by
   *  drive-share-service's hourly sync (joins) or the role-grant backfill (leaves). */
  changed(notice: RoleMembershipNotice): Promise<void>;
}

export interface Deps {
  repo: IdentityRepo;
  /** Passkey credential store (/internal/webauthn/*). Absent => those routes 503. */
  webauthn?: WebauthnRepo;
  audit: AuditSink;
  revoker: SessionRevoker;
  /** Role membership changes for drive-share-service. Absent = nobody listens (tests, bare deploys). */
  membership?: RoleMembershipSink;
  now: () => string; // @dub/db nowIso
  newId: (prefix: string) => string; // @dub/db newId
  defaultOrgId: string; // common.DUB_DEFAULT_ORG_ID
}
