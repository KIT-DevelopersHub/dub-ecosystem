// Production wiring of the Deps side-effect sinks over Cloudflare bindings.
// Degraded fallbacks keep the P0 unit deployable before audit-log / auth-service
// bindings exist; the fail-close contract still holds once they are wired.
import { createServiceClient, type RequestContext } from "@dub/http";
import { publishAudit, type AuditRecordEnvelopeV1 } from "@dub/events";
import { errors } from "@dub/errors";
import type { auditLog } from "@dub/types";
import type { AuditSink, RequestCtx, SessionRevoker } from "./deps";
import type { Env } from "./env";
import { AUDIT_TOPIC, outboxQueue } from "./outbox";

const SERVICE = "identity-roster";

export function createAuditSink(env: Env): AuditSink {
  const logClient = env.SVC_AUDIT_LOG
    ? createServiceClient(env.SVC_AUDIT_LOG, { service: "audit-log", caller: SERVICE, timeoutMs: 2000, retry: { maxAttempts: 2 } })
    : null;
  // Prefer the real (paid) Queue when present; otherwise fall back to the free-tier
  // @dub/freeq D1 outbox shim so best-effort audit records are durably persisted (drained
  // to audit-log by the Cron in index.ts), never silently dropped. Only when BOTH are
  // absent (a bare unit deploy with no OUTBOX_DB) does publish stay a no-op.
  const queue = env.AUDIT_QUEUE ?? (env.OUTBOX_DB ? outboxQueue<AuditRecordEnvelopeV1>(env.OUTBOX_DB, AUDIT_TOPIC) : null);

  return {
    async logSync(input: auditLog.AuditRecordInput): Promise<void> {
      if (!logClient) return; // degraded (pre-integration): sync audit is a no-op
      const ctx: RequestContext = { requestId: input.requestId, ...(input.actorId ? { userId: input.actorId } : {}) };
      try {
        await logClient.post<auditLog.AuditLogWriteResponse>(ctx, "/internal/log", input, { idempotencyKey: `${input.action}:${input.requestId}:${input.resourceId ?? ""}` });
      } catch (cause) {
        throw errors.upstreamUnavailable("audit-log", cause); // fail-close: caller aborts the mutation
      }
    },
    async publish(input: auditLog.AuditRecordInput): Promise<void> {
      if (!queue) return; // degraded: best-effort audit dropped
      try {
        await publishAudit({ AUDIT_QUEUE: queue }, input);
      } catch {
        // best-effort: never surface into the business flow
      }
    },
  };
}

export function createSessionRevoker(env: Env): SessionRevoker {
  const client = env.SVC_AUTH
    ? createServiceClient(env.SVC_AUTH, { service: "auth-service", caller: SERVICE, timeoutMs: 2000, retry: { maxAttempts: 2 } })
    : null;
  return {
    async revokeUser(userId: string, ctx: RequestCtx): Promise<void> {
      if (!client) return; // degraded: no auth binding yet
      const rc: RequestContext = { requestId: ctx.requestId, ...(ctx.actorId ? { userId: ctx.actorId } : {}) };
      try {
        await client.post(rc, "/internal/revoke-user", { userId }, { idempotencyKey: `revoke:${userId}:${ctx.requestId}` });
      } catch (cause) {
        throw errors.upstreamUnavailable("auth-service", cause); // fail-close: suspend aborts
      }
    },
  };
}
