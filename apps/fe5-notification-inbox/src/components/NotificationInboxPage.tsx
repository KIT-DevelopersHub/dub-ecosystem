// NotificationInboxPage — the /notifications route. Owns filter state, mirrors
// it to the URL, wires list paging + read operations + click-through navigation
// (FE5 §2-1/§2-2, tests 1-8,14).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PageHeader, Stack } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import { useInbox } from "../hooks/useInbox";
import {
  EMPTY_FILTER,
  parseInboxFilter,
  serializeInboxFilter,
  type InboxFilter,
} from "../lib/inbox-filter";
import { matchesCategoryFilter } from "../lib/type-dictionary";
import { resolveLinkUrl } from "../lib/routes";
import { NotificationFilterBar } from "./NotificationFilterBar";
import { NotificationList } from "./NotificationList";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { itemLinkUrl } from "./NotificationCard";

function readFilterFromLocation(): InboxFilter {
  if (typeof window === "undefined") return EMPTY_FILTER;
  return parseInboxFilter(window.location.search);
}

export interface NotificationInboxPageProps {
  // Optional injected initial filter (tests / deep link); defaults to URL.
  initialFilter?: InboxFilter;
  // Page size for cursor paging (default 50, max 200 per CursorQuery).
  pageSize?: number;
}

export function NotificationInboxPage(props: NotificationInboxPageProps): ReactNode {
  const { navigate, toast } = useNotificationDeps();
  const [filter, setFilter] = useState<InboxFilter>(
    props.initialFilter ?? readFilterFromLocation(),
  );

  const inbox = useInbox(
    props.pageSize !== undefined ? { filter, pageSize: props.pageSize } : { filter },
  );

  // Category is a client-side filter (the inbox list endpoint does not filter by type).
  // Narrow the loaded items to the active tab before rendering + for the mark-all affordance.
  const visibleItems = inbox.items.filter((i) => matchesCategoryFilter(i.type, filter.category));

  // Mirror filter -> URL (shareable / back-nav; test 3).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = serializeInboxFilter(filter).toString();
    const next = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", next);
  }, [filter]);

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

  return (
    <Stack gap={4} testId="fe5-inbox-page">
      <PageHeader
        title="Notifications"
        actions={
          <MarkAllReadButton
            onClick={() => void inbox.markAllRead()}
            disabled={visibleItems.every((i) => i.readAt !== null)}
          />
        }
        testId="fe5-inbox-header"
      />
      <NotificationFilterBar filter={filter} onChange={setFilter} />
      <NotificationList
        items={visibleItems}
        hasMore={inbox.hasMore}
        loading={inbox.loading}
        error={inbox.error}
        onActivate={onActivate}
        onMarkUnread={(item) => void inbox.markUnread(item.id)}
        onLoadMore={() => void inbox.loadMore()}
        onRetry={() => void inbox.reload()}
      />
    </Stack>
  );
}

export default NotificationInboxPage;
