// Free-tier audit outbox shim (@dub/freeq). identity-roster's best-effort audit
// fan-out used a paid Cloudflare Queue producer (AUDIT_QUEUE, via @dub/events
// publishAudit). Queues are a Workers PAID feature, so a free-plan deploy cannot bind
// them and the publish sink used to degrade to a silent no-op (audit records dropped).
// This module returns a `Queue`-shaped adapter whose `send`/`sendBatch` instead durably
// INSERT each message into the @dub/freeq D1 outbox (freeq_outbox on the shared dub-core
// DB, bound as OUTBOX_DB). A Cron-triggered drain (see drain.ts) later forwards rows to
// audit-log. Nothing is dropped: the producer INSERT is the durability guarantee (rows
// survive as pending/done/failed until a retention job prunes them), mirroring the
// auth-service ⇄ audit-log freeq conversion.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";

// Outbox topic for audit records. Kept as a stable string so the drain can route a row
// to the right consumer and so operators can query freeq_outbox by topic. Matches the
// auth-service convention (audit-log's async ingest landing route).
export const AUDIT_TOPIC = "audit.record";

/**
 * A `Queue<T>`-shaped adapter whose `send`/`sendBatch` append to the freeq D1 outbox
 * under `topic`. Assignable everywhere @dub/events' publishAudit expects a Queue, so the
 * publish sink calls it unchanged. The row payload is the exact AuditRecordEnvelopeV1
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
