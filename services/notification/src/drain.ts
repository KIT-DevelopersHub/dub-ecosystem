// Free-tier audit outbox drain. Runs from the Cron Trigger (see index.ts scheduled +
// wrangler.free.toml [triggers]). Claims due pending freeq_outbox rows and forwards each
// to audit-log over the SVC_AUDIT service binding. @dub/freeq owns the retry/backoff/
// failed bookkeeping; delivery is at-least-once and the envelope id is the idempotency
// key (audit-log's insert is INSERT OR IGNORE), so a redelivery is safe.
//
// - audit.record -> audit-log POST /internal/audit-async. The row payload IS the exact
//   AuditRecordEnvelopeV1 publishAudit built ({type,version,id,payload}); the drain
//   forwards it verbatim — the SAME envelope the retired Queue consumer understood. A
//   non-2xx throws -> the row is retried with backoff and never lost.
import type { Fetcher } from "@cloudflare/workers-types";
import { drain, type Deliver, type DrainResult } from "@dub/freeq";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { Env } from "./env";
import { AUDIT_TOPIC } from "./outbox";

const AUDIT_ASYNC_PATH = "/internal/audit-async";

/** Delivery callback shared by the scheduled drain and tests. */
export function makeAuditDeliver(svc: Fetcher): Deliver {
  return async ({ topic, payload }) => {
    if (topic !== AUDIT_TOPIC) return; // unknown topic: ack (nothing to deliver)
    // payload IS the AuditRecordEnvelopeV1 publishAudit built; forward it verbatim.
    const res = await svc.fetch("https://audit-log" + AUDIT_ASYNC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HDR_INTERNAL]: INTERNAL_HEADER_VALUE,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`audit-log async ingest returned ${res.status}`);
  };
}

/**
 * One drain pass over the audit outbox (invoked from the Cron scheduled handler).
 * A temporarily-down audit-log keeps rows durable (pending) via backoff until they can
 * actually be delivered; maxAttempts is effectively unbounded so a delivery-failed audit
 * record is never abandoned into the terminal 'failed' state (it stays pending, retained,
 * never deleted).
 */
export function runAuditDrain(env: Env): Promise<DrainResult> {
  if (!env.OUTBOX_DB || !env.SVC_AUDIT) {
    // No outbox DB or audit binding (e.g. the paid deploy, which uses the real Queue +
    // Queue consumer and never schedules this drain). Nothing to do — no-op, not a throw.
    return Promise.resolve({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
  }
  return drain(env.OUTBOX_DB, makeAuditDeliver(env.SVC_AUDIT), {
    batchSize: 25,
    maxAttempts: Number.MAX_SAFE_INTEGER,
  });
}
