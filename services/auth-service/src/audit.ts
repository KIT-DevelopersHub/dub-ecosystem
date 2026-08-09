// Audit is Queue-only for auth (theme13): publishAudit -> dub-q-audit-record.
// Fire-and-forget — a publish failure must never break the auth flow.
import type { Queue } from "@cloudflare/workers-types";
import { publishAudit, type AuditRecordEnvelopeV1 } from "@dub/events";
import type { auditLog } from "@dub/types";
import { common } from "@dub/types";

export interface AuditInput {
  action: string; // "auth.session.login" | "auth.session.logout" | ...
  actorId: string | null;
  result: auditLog.AuditResult;
  requestId: string;
  resourceType?: string | null;
  resourceId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface Auditor {
  record(input: AuditInput): Promise<void>;
}

export class QueueAuditor implements Auditor {
  constructor(private readonly env: { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> }) {}
  async record(input: AuditInput): Promise<void> {
    const record: auditLog.AuditRecordInput = {
      action: input.action,
      actorId: input.actorId,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: input.result,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      details: input.details ?? null,
      requestId: input.requestId,
      occurredAt: new Date().toISOString(),
    };
    try {
      await publishAudit(this.env, record);
    } catch {
      // swallow: audit is best-effort (Queue retry/DLQ owns durability)
    }
  }
}
