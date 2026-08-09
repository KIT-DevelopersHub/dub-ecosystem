// Consumer for the dub-q-audit-record special channel (AuditRecordEnvelopeV1).
// This is NOT a DubEventEnvelope, so @dub/events createQueueHandler does not apply;
// the audit channel has its own envelope shape (type/version/id/payload).
import type { MessageBatch } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import { createDbClient } from "@dub/db";
import { consoleSink } from "@dub/observability";
import type { Env } from "./env";
import { SERVICE_NAME } from "./config";
import { parseAuditEnvelope } from "./validation";
import { insertRecord } from "./repo";

export async function consumeAuditQueue(batch: MessageBatch<AuditRecordEnvelopeV1>, env: Env): Promise<void> {
  const db = createDbClient(env.DB, { namespace: "audit" });
  for (const message of batch.messages) {
    try {
      const { id, input } = parseAuditEnvelope(message.body);
      await insertRecord(db, id, input); // INSERT OR IGNORE => idempotent on re-delivery
      message.ack();
    } catch (err) {
      // Poison / transient failure: retry. After max_retries the queue routes it to
      // the DLQ (dub-q-audit-record-dlq). The consumer never crashes the batch.
      consoleSink({
        level: "error",
        message: "audit queue message failed; retrying",
        service: SERVICE_NAME,
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
      message.retry();
    }
  }
}
