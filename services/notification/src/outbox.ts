// Free-tier audit outbox shim (@dub/freeq). notification's best-effort delivery-failed
// audit fan-out used a paid Cloudflare Queue producer (AUDIT_QUEUE, via @dub/events
// publishAudit). Queues are a Workers PAID feature, so a free-plan deploy cannot bind
// them and the publish path degraded to a silent no-op (delivery-failed audit records
// dropped — audit lost). This module returns a `Queue`-shaped adapter whose
// `send`/`sendBatch` instead durably INSERT each message into the @dub/freeq D1 outbox
// (freeq_outbox on the shared dub-core DB, bound as OUTBOX_DB). A Cron-triggered drain
// (see drain.ts, invoked from the scheduled handler) later forwards rows to audit-log.
// Nothing is dropped: the producer INSERT is the durability guarantee (rows survive as
// pending/done/failed until a retention job prunes them), mirroring the
// auth-service / identity-roster ⇄ audit-log freeq conversion.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import type { Env } from "./env";

// Outbox topic for audit records (mirrors the retired dub-q-audit-record channel). Kept
// as a stable string so the drain can route a row to the right consumer and operators can
// query freeq_outbox by topic. Matches the auth-service / identity-roster convention.
export const AUDIT_TOPIC = "audit.record";

/**
 * A `Queue<T>`-shaped adapter whose `send`/`sendBatch` append to the freeq D1 outbox
 * under `topic`. Assignable everywhere @dub/events' publishAudit expects a Queue, so the
 * delivery path calls it unchanged. The row payload is the exact AuditRecordEnvelopeV1
 * publishAudit built; its stable `.id` is the downstream idempotency key (audit-log's
 * insert is INSERT OR IGNORE), so at-least-once redelivery is safe.
 */
export function outboxQueue<T>(db: D1Database, topic: string): Queue<T> {
  return {
    async send(body: T): Promise<void> {
      await enqueue(db, topic, body);
    },
    async sendBatch(batch: Iterable<{ body: T }>): Promise<void> {
      for (const msg of batch) await enqueue(db, topic, msg.body);
    },
  } as unknown as Queue<T>;
}

/**
 * Resolve the audit producer for publishAudit. Prefers the real (paid) Cloudflare Queue
 * when present; otherwise falls back to the free-tier @dub/freeq D1 outbox shim so
 * delivery-failed audit records are durably persisted (drained to audit-log by the Cron
 * in index.ts), never silently dropped. Only when BOTH are absent (a bare unit deploy
 * with no OUTBOX_DB) is there no sink — returns null and the delivery path skips publish
 * (a safe no-op, never a throw).
 */
export function resolveAuditQueue(env: Env): { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> } | null {
  if (env.AUDIT_QUEUE) return { AUDIT_QUEUE: env.AUDIT_QUEUE };
  if (env.OUTBOX_DB) return { AUDIT_QUEUE: outboxQueue<AuditRecordEnvelopeV1>(env.OUTBOX_DB, AUDIT_TOPIC) };
  return null;
}
