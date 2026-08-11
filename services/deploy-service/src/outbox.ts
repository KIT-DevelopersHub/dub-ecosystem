// Free-tier outbox shim (@dub/freeq). deploy-service used three paid Cloudflare Queue
// producers — AUDIT_QUEUE (result-stage audit), EVT_NOTIFICATION (deploy.* fan-out) and
// its PRIVATE DEPLOY_JOBS job queue (async exec + poll). Queues are a Workers PAID
// feature, so a free-plan deploy cannot bind them. This module returns adapters that
// durably INSERT each message into the @dub/freeq D1 outbox (freeq_outbox on the shared
// dub-core DB) instead. A Cron-triggered drain (see drain.ts) later forwards each row to
// its real consumer. Nothing is dropped: the producer INSERT is the durability guarantee
// (rows survive as pending/done/failed until a retention job prunes them). Mirrors the
// mail-gateway / auth-service ⇄ audit-log freeq conversion.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import type { DeployJobMessage } from "./jobs";

// Outbox topics (one per retired queue binding). Stable strings so the drain can route a
// row to the right consumer and operators can query freeq_outbox by topic. AUDIT_TOPIC
// matches the auth-service / mail-gateway convention (audit-log's async ingest).
export const AUDIT_TOPIC = "audit.record";
export const TOPIC_NOTIFICATION = "evt.notification";
export const TOPIC_DEPLOY_JOB = "deploy.job";

// Domain-event topics have no free-tier consumer HTTP route yet; the drain defers them
// (they stay durable/pending) rather than dropping them. Audit is delivered to audit-log
// and deploy.job is executed in process by this same worker's drain.
export const EVENT_TOPICS = [TOPIC_NOTIFICATION] as const;

/**
 * A `Queue<T>`-shaped adapter whose `send`/`sendBatch` append to the freeq D1 outbox
 * under `topic`. Assignable everywhere the @dub/events publishers expect a Queue, so
 * publishEvent / publishAudit call it unchanged. The row payload is the exact envelope
 * the publisher built (DubEventEnvelope / AuditRecordEnvelopeV1); its stable `.id` is the
 * downstream idempotency key, so at-least-once redelivery is safe.
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
 * Free-tier replacement for `env.DEPLOY_JOBS.send(msg, { delaySeconds })`. Appends the
 * private deploy-job message to the freeq outbox under TOPIC_DEPLOY_JOB; the Cron drain
 * runs it in process (same handler as the paid Queue consumer, idempotent). NOTE: the
 * paid queue's `delaySeconds` (used to space the CF poll loop) has no equivalent in the
 * outbox INSERT, so on the free tier the poll cadence is governed by the Cron drain
 * interval instead — best-effort, never a message loss (MAX_POLL_ATTEMPTS still bounds it).
 */
export async function enqueueDeployJob(db: D1Database, msg: DeployJobMessage): Promise<void> {
  await enqueue(db, TOPIC_DEPLOY_JOB, msg);
}
