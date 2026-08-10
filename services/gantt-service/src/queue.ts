// Inbound event consumer: purge the DTO cache when task/action/event data changes.
// event.archived additionally reaps the event's view-state rows (§4 cascade rule).
// gantt publishes nothing; all handling is naturally idempotent (purge/DELETE).
//
// On the Workers FREE plan there is no Queue consumer (dub-q-evt-gantt). The SAME handler
// logic is reached over HTTP via the /internal/events-async landing route (see app.ts):
// task-service / event-service forward each due task.*/action.*/event.* envelope from
// their own @dub/freeq D1 outbox drains. dispatchEvent is the single-envelope path shared
// by that route, so the purge/reap logic lives in exactly one place regardless of
// transport. gantt is a read model and never calls those services back, so wiring the
// consumer over HTTP does NOT reintroduce the event↔task cycle. Handlers are idempotent
// (purge/DELETE), so an at-least-once redelivery from a drain is safe with no dedup store.
import { createQueueHandler, type DubEventEnvelope, type DubEventHandlerMap } from "@dub/events";
import type { common } from "@dub/types";
import type { Env } from "./env";
import type { AppDeps } from "./ports";
import { defaultDeps } from "./deps";

/** Domain-event handlers (transport-agnostic: shared by the Queue consumer and the free-tier route). */
export function ganttEventHandlers(env: Env, deps: AppDeps = defaultDeps): DubEventHandlerMap {
  const cache = deps.cache(env);
  const views = deps.views(env);
  const purge = (eventId: common.EventId): Promise<void> => cache.purge(eventId);

  return {
    // task.* (all carry eventId; status/assignee are in the DTO -> must purge)
    "task.created": (e) => purge(e.payload.eventId),
    "task.updated": (e) => purge(e.payload.eventId),
    "task.assigned": (e) => purge(e.payload.eventId),
    "task.status_changed": (e) => purge(e.payload.eventId),
    "task.archived": (e) => purge(e.payload.eventId),
    "task.dependency_changed": (e) => purge(e.payload.eventId),
    // action.*
    "action.created": (e) => purge(e.payload.eventId),
    "action.updated": (e) => purge(e.payload.eventId),
    "action.status_changed": (e) => purge(e.payload.eventId),
    "action.archived": (e) => purge(e.payload.eventId),
    // event.*
    "event.updated": (e) => purge(e.payload.eventId),
    "event.phase_changed": (e) => purge(e.payload.eventId),
    "event.archived": async (e) => {
      await purge(e.payload.eventId);
      await views.deleteByEvent(e.payload.eventId);
    },
  };
}

export function buildQueueConsumer(env: Env, deps: AppDeps = defaultDeps) {
  return createQueueHandler(ganttEventHandlers(env, deps), { onUnknownEvent: "ack" });
}

/**
 * Deliver a single event envelope through the same handlers the Queue consumer uses.
 * Used by the free-tier /internal/events-async landing route. Unknown event names are a
 * no-op (acked), exactly like the Queue path (onUnknownEvent: "ack"). Handlers are
 * idempotent, so a redelivery by the caller's drain is safe; a thrown error propagates so
 * the caller's drain keeps the row pending and retries (event never lost).
 */
export async function dispatchEvent(env: Env, envelope: DubEventEnvelope, deps: AppDeps = defaultDeps): Promise<void> {
  const handlers = ganttEventHandlers(env, deps) as Record<
    string,
    ((e: DubEventEnvelope, c: { requestId: string }) => Promise<void>) | undefined
  >;
  const handler = handlers[envelope.name];
  if (handler) await handler(envelope, { requestId: envelope.requestId });
}
