// TanStack Query keys. FeatureModule id regrain: every key MUST start with the
// module id "events" (theme5). Centralised so cache invalidation stays consistent.
import type { common, event } from "@dub/types";

export const eventKeys = {
  all: ["events"] as const,
  lists: () => [...eventKeys.all, "list"] as const,
  list: (query: Partial<event.ListEventsQuery>) => [...eventKeys.lists(), query] as const,
  // Separate slot: infinite pages have a different cache shape than list().
  listInfinite: (query: Partial<event.ListEventsQuery>) => [...eventKeys.lists(), "infinite", query] as const,
  details: () => [...eventKeys.all, "detail"] as const,
  detail: (eventId: common.EventId) => [...eventKeys.details(), eventId] as const,
  eventDetails: (eventId: common.EventId) => [...eventKeys.detail(eventId), "eventDetails"] as const,
  sectionLayout: (eventId: common.EventId) => [...eventKeys.detail(eventId), "sectionLayout"] as const,
  pageLayout: (eventId: common.EventId) => [...eventKeys.detail(eventId), "pageLayout"] as const,
  // Shared with the FE2 shell launcher (exported) so a toggle greys the tile at once.
  apps: (eventId: common.EventId) => [...eventKeys.detail(eventId), "apps"] as const,
  digest: (eventId: common.EventId) => [...eventKeys.detail(eventId), "aiDigest"] as const,
  actions: (eventId: common.EventId) => [...eventKeys.detail(eventId), "actions"] as const,
  action: (actionId: common.ActionId) => [...eventKeys.all, "action", actionId] as const,
  users: (ids: readonly string[]) => [...eventKeys.all, "users", [...ids].sort().join(",")] as const,
} as const;
