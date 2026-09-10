// Inbox filter <-> URL query serialization (pure). The inbox filter state is
// mirrored into the URL (?unread=1&cat=app_update&type=task.) so it is shareable /
// back-nav safe (FE5 §3, test 3). No React here.
//
// Two orthogonal axes:
//  - `category` drives the user-facing tabs (All / 参加届 / アプリアップデート / フィードバック / メール) and is
//    applied CLIENT-SIDE (the inbox list endpoint does not filter by type — see repo.listInbox).
//  - `type` is a legacy server-side type-prefix filter kept for the admin/deep-link paths and
//    for type-scoped mark-all-read; the tabs no longer set it (defaults to "").

import { type CategoryFilter } from "./type-dictionary";

export interface InboxFilter {
  unreadOnly: boolean;
  category: CategoryFilter; // tab selection ("all" = no category filter)
  type: string; // legacy type-prefix ("task.") or "" for all — not set by the tabs
}

export const EMPTY_FILTER: InboxFilter = { unreadOnly: false, category: "all", type: "" };

const CATEGORY_VALUES: CategoryFilter[] = ["all", "app_update", "mail", "participation", "feedback", "other"];

function parseCategory(raw: string | null): CategoryFilter {
  return raw !== null && (CATEGORY_VALUES as string[]).includes(raw) ? (raw as CategoryFilter) : "all";
}

// Parse a URLSearchParams (or query string) into an InboxFilter.
export function parseInboxFilter(input: URLSearchParams | string): InboxFilter {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const unreadOnly = params.get("unread") === "1";
  const category = parseCategory(params.get("cat"));
  const type = params.get("type") ?? "";
  return { unreadOnly, category, type };
}

// Serialize an InboxFilter to a URLSearchParams (omitting default values so the
// URL stays clean).
export function serializeInboxFilter(filter: InboxFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.unreadOnly) params.set("unread", "1");
  if (filter.category && filter.category !== "all") params.set("cat", filter.category);
  if (filter.type) params.set("type", filter.type);
  return params;
}

// Build the ListInboxQuery-shaped params for the api call from a filter + cursor.
// Note: `category` is deliberately NOT sent — it is a client-side filter.
export interface InboxQueryParams {
  unreadOnly?: boolean;
  type?: string;
  cursor?: string;
  limit?: number;
}

export function toInboxQuery(
  filter: Pick<InboxFilter, "unreadOnly" | "type">,
  opts: { cursor?: string; limit?: number } = {},
): InboxQueryParams {
  const q: InboxQueryParams = {};
  if (filter.unreadOnly) q.unreadOnly = true;
  if (filter.type) q.type = filter.type;
  if (opts.cursor) q.cursor = opts.cursor;
  if (opts.limit !== undefined) q.limit = opts.limit;
  return q;
}
