// Queue consumer (task lane dub-q-evt-task). event.archived compensation: bulk
// soft-archive the event's tasks WITHOUT emitting per-task task.archived (storm
// prevention — other consumers pick up event.archived directly). envelope.id
// idempotency is enforced by the shared IdempotencyStore.
import type { MessageBatch } from "@cloudflare/workers-types";
import { createQueueHandler, type DubEventEnvelope } from "@dub/events";
import { nowIso } from "@dub/db";
import type { Deps } from "./deps";

export function buildQueueHandler(deps: Deps): (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> {
  return createQueueHandler(
    {
      "event.archived": async (event) => {
        await deps.repo.archiveByEvent(event.payload.eventId, nowIso());
      },
    },
    { idempotency: deps.idempotency, onUnknownEvent: "ack" },
  );
}
