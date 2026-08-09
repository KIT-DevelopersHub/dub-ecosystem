// Inbound event consumer: purge the DTO cache when task/action/event data changes.
// event.archived additionally reaps the event's view-state rows (§4 cascade rule).
// gantt publishes nothing; all handling is naturally idempotent (purge/DELETE).
import { createQueueHandler, type DubEventHandlerMap } from "@dub/events";
import type { common } from "@dub/types";
import type { Env } from "./env";
import type { AppDeps } from "./ports";
import { defaultDeps } from "./deps";

export function buildQueueConsumer(env: Env, deps: AppDeps = defaultDeps) {
  const cache = deps.cache(env);
  const views = deps.views(env);
  const purge = (eventId: common.EventId): Promise<void> => cache.purge(eventId);

  const handlers: DubEventHandlerMap = {
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

  return createQueueHandler(handlers, { onUnknownEvent: "ack" });
}
