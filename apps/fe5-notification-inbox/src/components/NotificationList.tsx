// NotificationList — renders InboxItem[] as a FLAT, chronological (newest-first) stream:
// no in-list genre grouping/headers. Genre separation is done by the tabs (すべて / per
// category) in NotificationFilterBar; the "すべて" tab shows every genre interleaved in
// time order. LoadMore paging (no auto-fire), skeleton on first load, and empty/error
// states (FE5 §2-2, tests 1,2,14). Every item stays a role="listitem".

import type { ReactNode } from "react";
import { Button, EmptyState, LoadMore, SkeletonLoader } from "@dub/ui";
import type { ApiError } from "../contracts/fe2";
import type { InboxItem } from "../contracts/notification-api";
import { NotificationListItem } from "./NotificationListItem";
import styles from "./NotificationList.module.css";

export interface NotificationListProps {
  items: InboxItem[];
  hasMore: boolean;
  loading: boolean;
  error: ApiError | null;
  onActivate: (item: InboxItem) => void;
  /** Optional: restore a read item to unread (passed through to each row). */
  onMarkUnread?: (item: InboxItem) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

export function NotificationList(props: NotificationListProps): ReactNode {
  const { items, hasMore, loading, error } = props;

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title="Couldn’t load notifications"
        description="Something went wrong while loading your inbox."
        action={<Button onClick={props.onRetry}>Retry</Button>}
        testId="fe5-inbox-error"
      />
    );
  }

  if (loading && items.length === 0) {
    return <SkeletonLoader lines={5} testId="fe5-inbox-skeleton" />;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="You’re all caught up"
        description="No notifications to show."
        testId="fe5-inbox-empty"
      />
    );
  }

  return (
    <div role="list" className={styles.list} data-testid="fe5-inbox-list">
      {items.map((item) => (
        <div role="listitem" className={styles.rowItem} key={item.id}>
          <NotificationListItem
            item={item}
            onActivate={props.onActivate}
            {...(props.onMarkUnread ? { onMarkUnread: props.onMarkUnread } : {})}
          />
        </div>
      ))}
      <LoadMore
        hasMore={hasMore}
        loading={loading}
        onLoadMore={props.onLoadMore}
        testId="fe5-inbox-loadmore"
      />
    </div>
  );
}
