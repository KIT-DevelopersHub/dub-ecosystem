// Queue consumer for dub-q-evt-mobile-bff. MO3 subscribes to task.*/event.*/action.*
// (theme1) to build the differential-sync change_log. That log is STUB in P0
// (theme14 D2 — change_log table is not created), so the handler is a no-op that
// ACKs every message (forward-compatible). It is wired here so the consumer binding
// and idempotency plumbing exist ahead of the offline-sync wave.
import type { MessageBatch } from "@cloudflare/workers-types";
import { createQueueHandler, type DubEventEnvelope } from "@dub/events";

export const mobileQueueHandler: (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> =
  createQueueHandler(
    {
      // No handlers registered in P0: every subscribed event is ACKed via the
      // onUnknownEvent="ack" default. The change_log writers land in the sync wave.
    },
    { onUnknownEvent: "ack" },
  );
