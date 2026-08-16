// NotificationInboxPage — the /notifications route. Owns filter + search + page state,
// mirrors filter to the URL, and paginates Gmail-style (numbered prev/next pages)
// instead of an infinite "load more". Cursor paging still backs it under the hood:
// each page maps to one fetched page, and Next lazily fetches the following page.
// (FE5 §2-1/§2-2, tests 1-8,14.)

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageHeader, Pagination, Stack } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import { useInbox } from "../hooks/useInbox";
import {
  EMPTY_FILTER,
  parseInboxFilter,
  serializeInboxFilter,
  type InboxFilter,
} from "../lib/inbox-filter";
import { resolveLinkUrl } from "../lib/routes";
import { NotificationFilterBar } from "./NotificationFilterBar";
import { NotificationList } from "./NotificationList";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { itemLinkUrl } from "./NotificationListItem";

// DS-reasonable page size for the full inbox (Gmail sits around 25–50/page).
export const NOTIF_PAGE_SIZE = 25;

function readFilterFromLocation(): InboxFilter {
  if (typeof window === "undefined") return EMPTY_FILTER;
  return parseInboxFilter(window.location.search);
}

// Client-side match for the search box: case-insensitive substring over title/body.
function matchesQuery(item: InboxItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return item.title.toLowerCase().includes(needle) || item.body.toLowerCase().includes(needle);
}

export interface NotificationInboxPageProps {
  // Optional injected initial filter (tests / deep link); defaults to URL.
  initialFilter?: InboxFilter;
  // Page size for cursor paging + display window (default 25, max 200 per CursorQuery).
  pageSize?: number;
}

export function NotificationInboxPage(props: NotificationInboxPageProps): ReactNode {
  const { navigate, toast } = useNotificationDeps();
  const [filter, setFilter] = useState<InboxFilter>(
    props.initialFilter ?? readFilterFromLocation(),
  );
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0); // 0-based display page

  const displaySize = props.pageSize ?? NOTIF_PAGE_SIZE;
  const inbox = useInbox({ filter, pageSize: displaySize });

  // Mirror filter -> URL (shareable / back-nav; test 3).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = serializeInboxFilter(filter).toString();
    const next = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", next);
  }, [filter]);

  // Changing the filter or the search query resets to the first page.
  const updateFilter = useCallback((next: InboxFilter) => {
    setFilter(next);
    setPage(0);
  }, []);
  const updateQuery = useCallback((next: string) => {
    setQuery(next);
    setPage(0);
  }, []);

  const onActivate = useCallback(
    (item: InboxItem) => {
      void inbox.markRead(item.id); // read + navigate happen together (test 8)
      const target = resolveLinkUrl(itemLinkUrl(item));
      if (target) {
        if (target.fellBack) toast.show("info", "Opening your inbox.");
        navigate(target.path);
      }
    },
    [inbox, navigate, toast],
  );

  // Search filters the loaded buffer client-side; paging then windows the result.
  const filtered = useMemo(
    () => (query ? inbox.items.filter((i) => matchesQuery(i, query)) : inbox.items),
    [inbox.items, query],
  );
  const searching = query.length > 0;

  const visible = filtered.slice(page * displaySize, page * displaySize + displaySize);

  // Total pages: known loaded pages, plus one more when the server still has rows to
  // fetch (only meaningful when NOT client-side searching the already-loaded buffer).
  const canFetchMore = inbox.hasMore && !searching;
  const totalCount = filtered.length + (canFetchMore ? displaySize : 0);
  const showPager = totalCount > displaySize;

  const onPageChange = useCallback(
    (next1Based: number) => {
      const target = Math.max(0, next1Based - 1);
      // Reaching a page past what's loaded triggers a lazy fetch of the next cursor page.
      if (!searching && target * displaySize >= inbox.items.length && inbox.hasMore) {
        void inbox.loadMore().then(() => setPage(target));
      } else {
        setPage(target);
      }
    },
    [inbox, displaySize, searching],
  );

  return (
    <Stack gap={4} testId="fe5-inbox-page">
      <PageHeader
        title="Notifications"
        actions={
          <MarkAllReadButton
            onClick={() => void inbox.markAllRead()}
            disabled={inbox.items.every((i) => i.readAt !== null)}
          />
        }
        testId="fe5-inbox-header"
      />
      <NotificationFilterBar
        filter={filter}
        onChange={updateFilter}
        query={query}
        onQueryChange={updateQuery}
      />
      <NotificationList
        items={visible}
        hasMore={false}
        loading={inbox.loading}
        error={inbox.error}
        onActivate={onActivate}
        onLoadMore={() => void inbox.loadMore()}
        onRetry={() => void inbox.reload()}
        onMarkUnread={(item) => void inbox.markUnread(item.id)}
      />
      {showPager ? (
        <Pagination
          page={page + 1}
          pageSize={displaySize}
          totalCount={totalCount}
          onPageChange={onPageChange}
          testId="fe5-inbox-pagination"
        />
      ) : null}
    </Stack>
  );
}

export default NotificationInboxPage;
