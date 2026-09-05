// Pure inbox list state transitions (cursor paging, optimistic read, 404 drop).
// Keeps the hook logic testable without React (tests 2,4,6,7).

import type { InboxItem } from "../contracts/notification-api";

export interface InboxState {
  items: InboxItem[];
  nextCursor: string | null; // null = end of results (hasMore=false)
  loading: boolean;
}

export const EMPTY_INBOX: InboxState = { items: [], nextCursor: null, loading: false };

export function hasMore(state: InboxState): boolean {
  return state.nextCursor !== null;
}

// Append a fetched page, de-duplicating by id (idempotent LoadMore).
export function appendPage(
  state: InboxState,
  page: { items: InboxItem[]; nextCursor: string | null },
): InboxState {
  const seen = new Set(state.items.map((i) => i.id));
  const merged = [...state.items];
  for (const item of page.items) {
    if (!seen.has(item.id)) merged.push(item);
  }
  return { items: merged, nextCursor: page.nextCursor, loading: false };
}

// Replace the list with the first page (used on filter change / refetch).
export function replaceFirstPage(
  state: InboxState,
  page: { items: InboxItem[]; nextCursor: string | null },
): InboxState {
  return { items: [...page.items], nextCursor: page.nextCursor, loading: false };
}

// Optimistically mark one item read (readAt set). Returns [next, rollback].
export function markReadLocally(
  state: InboxState,
  id: string,
  now: string,
): [InboxState, InboxState] {
  const next: InboxState = {
    ...state,
    items: state.items.map((i) => (i.id === id && i.readAt === null ? { ...i, readAt: now } : i)),
  };
  return [next, state];
}

// Optimistically mark one item UNREAD again (readAt cleared). Returns [next, rollback].
export function markUnreadLocally(
  state: InboxState,
  id: string,
): [InboxState, InboxState] {
  const next: InboxState = {
    ...state,
    items: state.items.map((i) => (i.id === id && i.readAt !== null ? { ...i, readAt: null } : i)),
  };
  return [next, state];
}

// Optimistically mark all read (respecting an optional type prefix filter).
export function markAllReadLocally(
  state: InboxState,
  now: string,
  typePrefix?: string,
): [InboxState, InboxState] {
  const next: InboxState = {
    ...state,
    items: state.items.map((i) =>
      i.readAt === null && (!typePrefix || i.type.startsWith(typePrefix))
        ? { ...i, readAt: now }
        : i,
    ),
  };
  return [next, state];
}

// Remove an item entirely (404 handling: item already gone — test 6).
export function removeItem(state: InboxState, id: string): InboxState {
  return { ...state, items: state.items.filter((i) => i.id !== id) };
}

// Count unread items currently held (used for local badge reconciliation).
export function unreadCount(state: InboxState): number {
  return state.items.reduce((n, i) => (i.readAt === null ? n + 1 : n), 0);
}
