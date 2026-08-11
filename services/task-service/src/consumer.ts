// Queue consumer (task lane dub-q-evt-task). event.archived compensation: bulk
// soft-archive the event's tasks WITHOUT emitting per-task task.archived (storm
// prevention — other consumers pick up event.archived directly). envelope.id
// idempotency is enforced by the shared IdempotencyStore.
//
// On the Workers FREE plan there is no Queue consumer; the SAME handler logic is reached
// over HTTP via the /internal/events-async landing route (see app.ts), which event-service's
// own free-tier @dub/freeq drain POSTs to. dispatchEvent is the single-envelope path shared
// by that route, so the compensation logic lives in exactly one place regardless of
// transport. task-service never calls event-service back from here, so the event↔task
// cycle is not reintroduced.
import type { MessageBatch } from "@cloudflare/workers-types";
import { createQueueHandler, type DubEventEnvelope, type DubEventHandlerMap } from "@dub/events";
import { nowIso } from "@dub/db";
import type { Deps } from "./deps";

/** Domain-event handlers (transport-agnostic). Currently only event.archived compensation. */
export function eventHandlers(deps: Deps): DubEventHandlerMap {
  return {
    "event.archived": async (event) => {
      await deps.repo.archiveByEvent(event.payload.eventId, nowIso());
    },
  };
}

export function buildQueueHandler(deps: Deps): (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> {
  return createQueueHandler(eventHandlers(deps), { idempotency: deps.idempotency, onUnknownEvent: "ack" });
}

/**
 * Deliver a single event envelope through the same handlers + idempotency the Queue
 * consumer uses. Used by the free-tier /internal/events-async landing route. Unknown
 * event names are acked (no handler) exactly like the Queue path (onUnknownEvent: "ack").
 * Idempotency mirrors createQueueHandler: dedup on envelope.id, mark processed after the
 * handler succeeds so a failed delivery is safely retried by the caller's drain.
 */
export async function dispatchEvent(deps: Deps, envelope: DubEventEnvelope): Promise<void> {
  if (await deps.idempotency.wasProcessed(envelope.id)) return;
  const handler = (eventHandlers(deps) as Record<string, ((e: DubEventEnvelope, c: { requestId: string }) => Promise<void>) | undefined>)[
    envelope.name
  ];
  if (handler) await handler(envelope, { requestId: envelope.requestId });
  await deps.idempotency.markProcessed(envelope.id);
}
