// Audit for auth is written to a free-tier D1 outbox (@dub/freeq), NOT a paid
// Cloudflare Queue. The producer only INSERTs a row (fire-and-forget: a write
// failure must never break the auth flow); a Cron-triggered drain (see drain.ts)
// forwards rows to audit-log and owns retry/backoff durability. The row id is the
// audit record's idempotency key, so at-least-once redelivery stays safe.
import type { D1Database } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import { redactSecrets } from "@dub/observability";
import type { auditLog } from "@dub/types";
import { common } from "@dub/types";

/** Outbox topic for audit records (mirrors the old dub-q-audit-record channel). */
export const AUDIT_TOPIC = "audit.record";

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

export class OutboxAuditor implements Auditor {
  constructor(private readonly db: D1Database) {}
  async record(input: AuditInput): Promise<void> {
    const record: auditLog.AuditRecordInput = {
      action: input.action,
      actorId: input.actorId,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: input.result,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      // Same sanitizer publishAudit applied before enqueue: strip secret keys (theme#13).
      details: input.details ? redactSecrets(input.details) : null,
      requestId: input.requestId,
      occurredAt: new Date().toISOString(),
    };
    try {
      await enqueue(this.db, AUDIT_TOPIC, record);
    } catch {
      // swallow: audit enqueue is best-effort; the login/session path must not fail
      // because the outbox INSERT hiccuped. Delivered rows are durable in D1.
    }
  }
}
