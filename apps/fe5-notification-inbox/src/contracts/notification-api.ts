// Notification wire contracts consumed by FE5.
//
// The canonical source is @dub/types (notification namespace). A few request/
// response shapes referenced by the FE5 design (GetPreferencesResponse,
// UpdatePreferencesRequest, ReadAllRequest) are not yet materialised in
// @dub/types at P0 — they are composed here from the frozen primitives that DO
// exist (PreferenceEntry / NotificationType) so FE5 codes against the same
// shapes. When types/D9 adds the aggregate names, this file collapses to a
// re-export with zero call-site changes (the field shapes match by design).

import type { notification } from "@dub/types";

// Re-export the frozen primitives under stable local names.
export type NotificationChannel = notification.NotificationChannel; // in_app|email|chat|push (closed)
export type NotificationType = notification.NotificationType; // open vocabulary (string)
export type InboxItem = notification.InboxItem;
export type ListInboxQuery = notification.ListInboxQuery;
export type ListInboxResponse = notification.ListInboxResponse; // Paginated<InboxItem>
export type UnreadCountResponse = notification.UnreadCountResponse;
export type PreferenceEntry = notification.PreferenceEntry;

// Closed set of channels in display order (matches @dub/types union).
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  "in_app",
  "email",
  "chat",
  "push",
] as const;

// GET /preferences — defaults (server code constants) + overrides (user rows).
export interface GetPreferencesResponse {
  defaults: PreferenceEntry[];
  overrides: PreferenceEntry[];
}

// PATCH /preferences — only the changed entries are sent (diff PATCH).
export interface UpdatePreferencesRequest {
  entries: PreferenceEntry[];
}

// POST /inbox/read-all — optional type prefix carried from the active filter.
export interface ReadAllRequest {
  type?: string;
}
