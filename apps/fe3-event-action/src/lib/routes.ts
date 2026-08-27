// Route builders FE3 publishes so other units link into the hierarchy without
// hard-coding paths. FE3 owns the `/events` tree by SEGMENT (theme5 1-3); the
// `/events/:eventId/tasks*` segment is delegated to FE4. Chat is NOT a child
// route — the "open chat" affordance navigates to /chat?eventId= (FE6).
import type { common } from "@dub/types";

// @dub/types exposes ids via the `common` namespace (prefix-ULID plain strings).
// No subpath export exists, so reference through the namespace and alias locally.
type Eid = common.EventId;
type Aid = common.ActionId;

export const eventRoutes = {
  list: (): string => "/events",
  /** The event grid/browser (create + filter). Hub is the `/events` home. */
  listAll: (): string => "/events/list",
  detail: (eventId: Eid): string => `/events/${eventId}`,
  action: (eventId: Eid, actionId: Aid): string => `/events/${eventId}/actions/${actionId}`,
  settings: (eventId: Eid): string => `/events/${eventId}/settings`,
  /** Delegated to FE4; FE3 only exposes the builder. */
  tasks: (eventId: Eid): string => `/events/${eventId}/tasks`,
} as const;

/** The "open chat" affordance target (FE6 resolves eventId); not a child route. */
export function chatHref(eventId: Eid): string {
  return `/chat?eventId=${encodeURIComponent(eventId)}`;
}

// Route path patterns (as registered in the FeatureModule; FE2 owns the router).
export const routePaths = {
  list: "/events", // the Event app home = EventHubPage (selected event's detail store)
  listAll: "/events/list", // the event grid/browser (EventListPage)
  detail: "/events/:eventId",
  action: "/events/:eventId/actions/:actionId",
  settings: "/events/:eventId/settings",
  tasks: "/events/:eventId/tasks", // delegated to FE4
} as const;
