// Free-tier publishers (#836). mail-automation's decided/routed events and its audit channel
// were paid Queue producers (EVT_NOTIFICATION / AUDIT_QUEUE), which a free-plan deploy cannot
// bind — the reason this Worker was never in deploy-prod.sh and prod kept an Aug-2026 build
// that 400'd every freeq delivery. Same shim as chat-service / mail-gateway: a Queue-shaped
// adapter that durably INSERTs into the shared freeq_outbox; freeq-drain forwards the rows.
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { enqueue } from "@dub/freeq";
import type { DubEventEnvelope } from "@dub/events";

/** freeq topics this service produces (keys of freeq-drain ROUTES). */
export const NOTIFICATION_TOPIC = "evt.notification";
export const AUDIT_TOPIC = "audit.record";

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

/** Prefer the real (paid) Queue binding when present, else the freeq outbox. */
export function publisherQueues(env: {
  DB: D1Database;
  EVT_NOTIFICATION?: Queue<DubEventEnvelope>;
  AUDIT_QUEUE?: Queue<never>;
}): { EVT_NOTIFICATION: Queue<DubEventEnvelope>; AUDIT_QUEUE: Queue<never> } {
  return {
    EVT_NOTIFICATION: env.EVT_NOTIFICATION ?? outboxQueue<DubEventEnvelope>(env.DB, NOTIFICATION_TOPIC),
    AUDIT_QUEUE: env.AUDIT_QUEUE ?? outboxQueue<never>(env.DB, AUDIT_TOPIC),
  };
}
