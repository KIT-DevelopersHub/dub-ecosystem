// Free-tier outbox drain. Runs from the Cron Trigger (see index.ts scheduled). Claims due
// pending freeq_outbox rows and forwards each to its real consumer. @dub/freeq owns the
// retry/backoff bookkeeping; delivery is at-least-once and the envelope/job id is the
// idempotency key, so a redelivery is safe.
//
// - audit.record  -> audit-log POST /internal/audit-async (the SAME AuditRecordEnvelopeV1
//   the retired Queue consumer understood). A non-2xx throws -> the row is retried with
//   backoff and never lost.
// - deploy.job    -> executed IN PROCESS via the same processJob() the paid Queue consumer
//   uses (idempotent). This keeps the private job lane internal — no self service-binding,
//   no HTTP round-trip, no re-introduced queue cycle. An infra error throws -> retried.
// - evt.notification -> DEFERRED. The deploy.* domain-event consumer (notification) has no
//   free-tier HTTP landing route yet, so the drain throws a benign deferral: the row stays
//   durable/pending and is redelivered later (once that route + SVC binding land) — never
//   dropped, never mislabeled 'done'. A high maxAttempts keeps deferred rows off 'failed'.
import { drain, type Deliver, type DrainResult } from "@dub/freeq";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env } from "./env";
import type { DepsFactory } from "./deps";
import { buildDeps } from "./deps";
import { processJob } from "./queue";
import type { DeployJobMessage } from "./jobs";
import { AUDIT_TOPIC, TOPIC_DEPLOY_JOB, EVENT_TOPICS } from "./outbox";

const AUDIT_ASYNC_PATH = "/internal/audit-async";

// Thrown for topics with no live consumer route yet; keeps the row pending (durable).
class OutboxDeferral extends Error {
  constructor(topic: string) {
    super(`no free-tier consumer route for topic "${topic}" yet; row retained pending`);
    this.name = "OutboxDeferral";
  }
}

/** Delivery callback shared by the scheduled drain and tests. `makeDeps` is injectable so
 *  tests can run deploy.job against in-memory repo/CF fakes (default = real buildDeps). */
export function makeOutboxDeliver(env: Env, makeDeps: DepsFactory = buildDeps): Deliver {
  return async ({ topic, payload }) => {
    if (topic === AUDIT_TOPIC) {
      // payload IS the AuditRecordEnvelopeV1 publishAudit built; forward it verbatim.
      const res = await env.SVC_AUDIT_LOG.fetch("https://audit-log" + AUDIT_ASYNC_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [HDR_INTERNAL]: INTERNAL_HEADER_VALUE },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`audit-log async ingest returned ${res.status}`);
      return;
    }
    if (topic === TOPIC_DEPLOY_JOB) {
      const job = payload as DeployJobMessage;
      const deps = makeDeps(env, job.requestId);
      await processJob(deps, job); // same handler as the paid consumer; idempotent
      return;
    }
    if ((EVENT_TOPICS as readonly string[]).includes(topic)) throw new OutboxDeferral(topic);
    // Unknown topic: ack (nothing to deliver) so a stray row does not churn forever.
  };
}

/**
 * One drain pass over the freeq outbox. `maxAttempts` is deliberately large so deferred
 * domain-event rows (and a temporarily-down audit-log) never reach the terminal 'failed'
 * state — every record stays durable in D1 until it can actually be delivered.
 */
export function runOutboxDrain(env: Env, makeDeps: DepsFactory = buildDeps): Promise<DrainResult> {
  return drain(env.DB, makeOutboxDeliver(env, makeDeps), { batchSize: 25, maxAttempts: Number.MAX_SAFE_INTEGER });
}
