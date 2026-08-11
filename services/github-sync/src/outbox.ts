// Free-tier outbox shim (@dub/freeq). github-sync's domain-event fan-out (github.* ->
// EVT_NOTIFICATION) + audit fan-out (AUDIT_QUEUE) used paid Cloudflare Queue producers.
// Queues are a Workers PAID feature, so a free-plan deploy cannot bind them. This module
// returns objects that satisfy the `Queue` interface the @dub/events publishers call
// (`send` / `sendBatch`) but, instead of a real Queue, durably INSERT each message into
// the @dub/freeq D1 outbox (freeq_outbox on the shared dub-core DB). A Cron-triggered
// drain (see drain.ts) later forwards rows to their real consumers. Nothing is dropped:
// the producer INSERT is the durability guarantee (rows survive as pending/done/failed
// until a retention job prunes them), mirroring the auth-service / mail-gateway / task-
// service <-> audit-log freeq conversion.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";

// Outbox topics (one per retired queue binding). Kept as stable strings so the drain can
// route a row to the right consumer and so operators can query freeq_outbox by topic.
// AUDIT_TOPIC matches the auth-service / mail-gateway / task-service convention (audit-log's
// async ingest). github.* events only route to EVT_NOTIFICATION (per @dub/events catalog:
// only github.sync_failed / github.conflict_detected have the "notification" subscriber).
export const AUDIT_TOPIC = "audit.record";
export const TOPIC_NOTIFICATION = "evt.notification";

// @dub/events publishEvent keys the fan-out by binding name; each maps to the outbox topic
// the drain routes it to. github-sync only publishes to EVT_NOTIFICATION. Keep in lockstep
// with wrangler.toml [[queues.producers]].
export const EVENT_BINDING_TOPIC: Readonly<Record<string, string>> = {
  EVT_NOTIFICATION: TOPIC_NOTIFICATION,
};

// Domain-event topics have no free-tier consumer HTTP route reachable from github-sync yet;
// the drain defers them (they stay durable/pending) rather than dropping them. Audit is the
// topic that currently has a live landing route (audit-log /internal/audit-async).
export const EVENT_TOPICS = [TOPIC_NOTIFICATION] as const;

/**
 * A `Queue<T>`-shaped adapter whose `send`/`sendBatch` append to the freeq D1 outbox under
 * `topic`. Assignable everywhere the @dub/events publishers expect a Queue, so publishEvent /
 * publishAudit call it unchanged. The row payload is the exact envelope the publisher built
 * (DubEventEnvelope / AuditRecordEnvelopeV1); its stable `.id` is the downstream idempotency
 * key, so at-least-once redelivery is safe.
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
