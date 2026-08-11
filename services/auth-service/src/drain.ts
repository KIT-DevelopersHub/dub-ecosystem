// Audit outbox drain. Runs from the free Cron Trigger (see wrangler.toml [triggers]).
// Claims due pending rows and forwards each to audit-log over the SVC_AUDIT service
// binding as the AuditRecordEnvelopeV1 the old Queue consumer already understands.
// @dub/freeq owns the retry/backoff/failed bookkeeping; delivery is at-least-once and
// the row id is the idempotency key (audit-log's insert is INSERT OR IGNORE).
import type { Fetcher } from "@cloudflare/workers-types";
import { drain, type Deliver, type DrainResult } from "@dub/freeq";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import { AUDIT_TOPIC } from "./audit";
import type { Env } from "./env";

// audit-log's async ingest for non-sync actions (auth.session.*). A 4xx/5xx (incl. 404
// before it lands) throws -> the row is retried with backoff and never lost.
const AUDIT_ASYNC_PATH = "/internal/audit-async";

// NOTE: the standalone freeq-drain worker is what runs this drain in production; this
// local drain is retained as the topic->destination contract source. Since theme#... the
// OUTBOX payload IS already the AuditRecordEnvelopeV1 (the producer wraps it in audit.ts),
// so delivery just forwards the payload VERBATIM — re-wrapping here would double-wrap.
export function makeAuditDeliver(svc: Fetcher): Deliver {
  return async ({ topic, payload }) => {
    if (topic !== AUDIT_TOPIC) return; // unknown topic: ack (nothing to deliver)
    const res = await svc.fetch("https://audit-log" + AUDIT_ASYNC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HDR_INTERNAL]: INTERNAL_HEADER_VALUE,
      },
      body: JSON.stringify(payload), // payload IS the envelope the producer enqueued
    });
    if (!res.ok) throw new Error(`audit-log async ingest returned ${res.status}`);
  };
}

/** One drain pass over the audit outbox (invoked from the Cron scheduled handler). */
export function runAuditDrain(env: Env): Promise<DrainResult> {
  return drain(env.OUTBOX_DB, makeAuditDeliver(env.SVC_AUDIT), {
    batchSize: 25,
    maxAttempts: 8,
  });
}
