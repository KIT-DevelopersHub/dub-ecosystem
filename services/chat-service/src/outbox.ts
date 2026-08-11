// Free-tier outbox shim (@dub/freeq). chat-service's chat.* fan-out and its audit
// channel used paid Cloudflare Queue producers (EVT_NOTIFICATION / AUDIT_QUEUE).
// Queues are a Workers PAID feature, so a free-plan deploy cannot bind them. This
// module returns objects that satisfy the `Queue` interface the @dub/events publishers
// call (`send` / `sendBatch`) but, instead of a real Queue, durably INSERT each
// message into the @dub/freeq D1 outbox (freeq_outbox on the shared dub-core DB). A
// Cron-triggered drain (see drain.ts) later forwards rows to their real consumers.
// Nothing is dropped: the producer INSERT is the durability guarantee (rows survive as
// pending/done/failed until a retention job prunes them), mirroring the auth-service,
// mail-gateway and event-service freeq conversions.
//
// The ChatRoom Durable Object (RT hub) is untouched here — it is not a Queue.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import { CONSUMER_QUEUE_BINDINGS, type ConsumerService, type DubEventEnvelope, type DubEventPublisherEnv } from "@dub/events";

// Audit topic — matches the auth-service / mail-gateway / event-service convention
// (audit-log's async ingest understands the AuditRecordEnvelopeV1 payload verbatim).
export const AUDIT_TOPIC = "audit.record";

// Outbox topic for a domain-event consumer (evt.notification, ...). Stable strings so
// the drain can route a row to the right consumer and operators can query freeq_outbox
// by topic. Derived from the frozen consumer key (already hyphenated).
export function eventTopic(consumer: ConsumerService): string {
  return `evt.${consumer}`;
}

// Every domain-event topic chat-service can fan out to. chat.* subscribes only to
// notification, but buildPublisherEnv covers the whole frozen consumer set so the shim
// stays identical to the other services. The drain DEFERS these (no free-tier consumer
// HTTP route yet) rather than dropping them.
export const EVENT_TOPICS: readonly string[] = (Object.keys(CONSUMER_QUEUE_BINDINGS) as ConsumerService[]).map(eventTopic);

/**
 * A `Queue<T>`-shaped adapter whose `send`/`sendBatch` append to the freeq D1 outbox
 * under `topic`. Assignable everywhere the @dub/events publishers expect a Queue, so
 * publishEvent / publishAudit call it unchanged. The row payload is the exact envelope
 * the publisher built (DubEventEnvelope / AuditRecordEnvelopeV1); its stable `.id` is
 * the downstream idempotency key, so at-least-once redelivery is safe.
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
 * Build the DubEventPublisherEnv publishEvent fans out over: for every frozen
 * consumer binding, prefer the real (paid) Queue when present, else fall back to a
 * freeq outbox adapter keyed by the consumer's topic. Missing bindings therefore
 * become durable D1 rows instead of a fail-loud EVENTS_MISSING_BINDING throw.
 */
export function buildPublisherEnv(
  db: D1Database,
  real: Partial<Record<string, Queue<DubEventEnvelope>>>,
): DubEventPublisherEnv {
  const env: Record<string, Queue<DubEventEnvelope>> = {};
  for (const [consumer, binding] of Object.entries(CONSUMER_QUEUE_BINDINGS)) {
    env[binding] = real[binding] ?? outboxQueue<DubEventEnvelope>(db, eventTopic(consumer as ConsumerService));
  }
  return env;
}
