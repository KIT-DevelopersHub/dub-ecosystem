// Free-tier outbox drain. Runs from the Cron Trigger (see index.ts scheduled). Claims
// due pending freeq_outbox rows and forwards each to its real consumer. @dub/freeq owns
// the retry/backoff bookkeeping; delivery is at-least-once and the envelope id is the
// idempotency key, so a redelivery is safe (audit-log's insert is INSERT OR IGNORE).
//
// - audit.record -> audit-log POST /internal/audit-async (the SAME AuditRecordEnvelopeV1
//   the retired AUDIT_QUEUE consumer understood). A non-2xx throws -> the row is retried
//   with backoff and never lost. When SVC_AUDIT is absent the row is deferred (kept
//   pending/durable) instead of dropped.
//
// MO3 produces ONLY audit.record (push delivery-failure). It does not produce domain
// events, so there are no evt.* rows to defer here — the consumer side (change_log) is a
// landing route (POST /internal/events-async), not a producer, so no cycle is introduced.
import { drain, type Deliver, type DrainResult } from "@dub/freeq";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env } from "./env";
import { AUDIT_TOPIC } from "./outbox";

const AUDIT_ASYNC_PATH = "/internal/audit-async";

// Thrown for a topic whose consumer binding is not present yet; keeps the row pending
// (durable) so it is redelivered once the binding lands — never dropped, never 'failed'.
class OutboxDeferral extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OutboxDeferral";
  }
}

/** Delivery callback shared by the scheduled drain and tests. */
export function makeOutboxDeliver(env: Env): Deliver {
  return async ({ topic, payload }) => {
    if (topic === AUDIT_TOPIC) {
      const svc = env.SVC_AUDIT;
      if (!svc) throw new OutboxDeferral('no SVC_AUDIT binding; row "audit.record" retained pending');
      // payload IS the AuditRecordEnvelopeV1 publishAudit built; forward it verbatim.
      const res = await svc.fetch("https://audit-log" + AUDIT_ASYNC_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [HDR_INTERNAL]: INTERNAL_HEADER_VALUE },
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
 * temporarily-down (or not-yet-bound) audit-log never pushes a row to the terminal
 * 'failed' state — every record stays durable in D1 until it can actually be delivered.
 */
export function runOutboxDrain(env: Env): Promise<DrainResult> {
  return drain(env.DB_MOBILE, makeOutboxDeliver(env), { batchSize: 25, maxAttempts: Number.MAX_SAFE_INTEGER });
}
