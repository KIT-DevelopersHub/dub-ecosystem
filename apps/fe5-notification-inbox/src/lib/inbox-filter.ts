// Inbox filter <-> URL query serialization (pure). The inbox filter state is
// mirrored into the URL (?unread=1&type=task.) so it is shareable/back-nav safe
// (FE5 §3, test 3). No React here.

// Chronological ordering of the inbox. "newest" is the default (created desc).
export type InboxSort = "newest" | "oldest";

export interface InboxFilter {
  unreadOnly: boolean;
  type: string; // prefix ("task.") or "" for all
  sort?: InboxSort; // "newest" (default) | "oldest"; absent = "newest"
}

export const EMPTY_FILTER: InboxFilter = { unreadOnly: false, type: "", sort: "newest" };

// Parse a URLSearchParams (or query string) into an InboxFilter.
export function parseInboxFilter(input: URLSearchParams | string): InboxFilter {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const unreadOnly = params.get("unread") === "1";
  const type = params.get("type") ?? "";
  const sort: InboxSort = params.get("sort") === "oldest" ? "oldest" : "newest";
  return { unreadOnly, type, sort };
}

// Serialize an InboxFilter to a URLSearchParams (omitting default values so the
// URL stays clean).
export function serializeInboxFilter(filter: InboxFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.unreadOnly) params.set("unread", "1");
  if (filter.type) params.set("type", filter.type);
  if (filter.sort === "oldest") params.set("sort", "oldest");
  return params;
}

// Build the ListInboxQuery-shaped params for the api call from a filter + cursor.
export interface InboxQueryParams {
  unreadOnly?: boolean;
  type?: string;
  sort?: InboxSort;
  cursor?: string;
  limit?: number;
}

export function toInboxQuery(
  filter: InboxFilter,
  opts: { cursor?: string; limit?: number } = {},
): InboxQueryParams {
  const q: InboxQueryParams = {};
  if (filter.unreadOnly) q.unreadOnly = true;
  if (filter.type) q.type = filter.type;
  // Only send the non-default direction so existing "newest" callers are byte-identical.
  if (filter.sort === "oldest") q.sort = "oldest";
  if (opts.cursor) q.cursor = opts.cursor;
  if (opts.limit !== undefined) q.limit = opts.limit;
  return q;
}
