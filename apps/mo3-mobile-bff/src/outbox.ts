// Free-tier outbox shim (@dub/freeq). MO3's only Queue producer is the push
// delivery-failure audit fan-out (AUDIT_QUEUE / publishAudit, theme13/D3). Queues are a
// Workers PAID feature, so a free-plan deploy cannot bind them. This module returns an
// object that satisfies the `Queue` interface the @dub/events publishAudit helper calls
// (`send` / `sendBatch`) but, instead of a real Queue, durably INSERTs each message into
// the @dub/freeq D1 outbox (freeq_outbox on the shared dub-core DB). A Cron-triggered
// drain (see drain.ts) later forwards audit rows to audit-log. Nothing is dropped: the
// producer INSERT is the durability guarantee (rows survive as pending/done/failed until
// a retention job prunes them), mirroring the auth-service / mail-gateway freeq conversion.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";

// Outbox topic for the retired AUDIT_QUEUE binding. Matches the auth-service /
// mail-gateway convention (audit-log's async ingest), so the same drain routing and
// audit-log's /internal/audit-async landing route apply unchanged.
export const AUDIT_TOPIC = "audit.record";

/**
 * A `Queue<T>`-shaped adapter whose `send`/`sendBatch` append to the freeq D1 outbox
 * under `topic`. Assignable everywhere the @dub/events publishers expect a Queue, so
 * publishAudit calls it unchanged. The row payload is the exact envelope the publisher
 * built (AuditRecordEnvelopeV1); its stable `.id` is the downstream idempotency key, so
 * at-least-once redelivery is safe.
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
