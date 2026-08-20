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
  hub: "/event-hub", // イベント詳細ハブ (current-event switcher + free-form detail store)
  list: "/events",
  detail: "/events/:eventId",
  action: "/events/:eventId/actions/:actionId",
  settings: "/events/:eventId/settings",
  tasks: "/events/:eventId/tasks", // delegated to FE4
} as const;
