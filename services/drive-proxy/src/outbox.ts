// Free-tier outbox shim (@dub/freeq). drive-proxy's event + audit fan-out used paid
// Cloudflare Queue producers (EVT_FILE_META / AUDIT_QUEUE). Queues are a Workers PAID
// feature, so a free-plan deploy cannot bind them. This module returns objects that
// satisfy the `Queue` interface the @dub/events publishers call (`send` / `sendBatch`)
// but, instead of a real Queue, durably INSERT each message into the @dub/freeq D1
// outbox (freeq_outbox on the shared dub-core DB, binding OUTBOX_DB). A Cron-triggered
// drain (see drain.ts) later forwards audit rows to audit-log and defers domain events.
// Nothing is dropped: the producer INSERT is the durability guarantee (rows survive as
// pending/done/failed until a retention job prunes them), mirroring mail-gateway ⇄
// audit-log and auth-service ⇄ audit-log freeq conversions.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import { enqueue } from "@dub/freeq";
import type { Env } from "./env";

// Outbox topics (one per retired queue binding). Kept as stable strings so the drain
// can route a row to the right consumer and operators can query freeq_outbox by topic.
// AUDIT_TOPIC matches the ecosystem convention (audit-log's async ingest landing route).
export const AUDIT_TOPIC = "audit.record";
export const TOPIC_FILE_META = "evt.file-meta";

// Domain-event topics have no free-tier consumer HTTP route yet; the drain defers them
// (they stay durable/pending) rather than dropping them. Audit is the only topic that
// currently has a live landing route (audit-log /internal/audit-async).
export const EVENT_TOPICS = [TOPIC_FILE_META] as const;

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

/** The publisher env shape createEventPublisher (events.ts) consumes. */
export interface PublisherEnv {
  EVT_FILE_META: Queue<DubEventEnvelope>;
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
}

// Prefer a real (paid) Queue binding when present; otherwise fall back to the free-tier
// @dub/freeq D1 outbox shim so every event/audit record is durably persisted, never
// dropped. On the free plan the Queue bindings are absent but OUTBOX_DB is bound; on the
// paid plan the Queues are present and OUTBOX_DB is never touched.
function resolveQueue<T>(queue: Queue<T> | undefined, db: D1Database | undefined, topic: string): Queue<T> {
  if (queue) return queue;
  if (db) return outboxQueue<T>(db, topic);
  throw new Error(`drive-proxy: no Queue binding and no OUTBOX_DB for topic "${topic}" (cannot publish durably)`);
}

/**
 * Build the publisher env from Worker bindings with binding-or-shim fallback. The
 * @dub/events publishers (publishEvent / publishAudit) call this env's `.send` unchanged,
 * so the free-tier swap is invisible above this seam.
 */
export function buildPublisherEnv(env: Env): PublisherEnv {
  return {
    EVT_FILE_META: resolveQueue(env.EVT_FILE_META, env.OUTBOX_DB, TOPIC_FILE_META),
    AUDIT_QUEUE: resolveQueue(env.AUDIT_QUEUE, env.OUTBOX_DB, AUDIT_TOPIC),
  };
}
