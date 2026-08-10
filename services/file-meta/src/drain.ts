// Free-tier outbox drain. Runs from the Cron Trigger (see index.ts scheduled). Claims
// due pending freeq_outbox rows and forwards each to its real consumer. @dub/freeq owns
// the retry/backoff bookkeeping; delivery is at-least-once and the envelope id is the
// idempotency key, so a redelivery is safe.
//
// - audit.record -> audit-log POST /internal/audit-async (the SAME AuditRecordEnvelopeV1
//   the retired Queue consumer understood). A non-2xx throws -> the row is retried with
//   backoff and never lost. When SVC_AUDIT is unbound the row is deferred (kept pending).
// - anything else -> ack (nothing to deliver): file-meta enqueues only audit rows, but a
//   stray/unknown topic must not churn the table forever.
import { drain, type Deliver, type DrainResult } from "@dub/freeq";
import { HEADERS, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env } from ".";
import { AUDIT_TOPIC } from "./outbox";

const AUDIT_ASYNC_PATH = "/internal/audit-async";

// Thrown for a topic with no live consumer route yet; keeps the row pending (durable).
class OutboxDeferral extends Error {
  constructor(topic: string) {
    super(`no free-tier consumer route for topic "${topic}" yet; row retained pending`);
    this.name = "OutboxDeferral";
  }
}

/** Delivery callback shared by the scheduled drain and tests. */
export function makeOutboxDeliver(env: Env): Deliver {
  return async ({ topic, payload }) => {
    if (topic === AUDIT_TOPIC) {
      const svc = env.SVC_AUDIT;
      if (!svc) throw new OutboxDeferral(topic); // no audit binding: keep the row durable
      // payload IS the AuditRecordEnvelopeV1 publishAudit built; forward it verbatim.
      const res = await svc.fetch("https://audit-log" + AUDIT_ASYNC_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [HEADERS.internal]: INTERNAL_HEADER_VALUE },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`audit-log async ingest returned ${res.status}`);
      return;
    }
    // Unknown topic: ack (nothing to deliver) so a stray row does not churn forever.
  };
}

/**
 * One drain pass over the freeq outbox. `maxAttempts` is deliberately large so a
 * temporarily-down audit-log (or an unbound SVC_AUDIT) never reaches the terminal
 * 'failed' state — every record stays durable in D1 until it can actually be delivered.
 */
export function runOutboxDrain(env: Env): Promise<DrainResult> {
  return drain(env.DB, makeOutboxDeliver(env), { batchSize: 25, maxAttempts: Number.MAX_SAFE_INTEGER });
}
