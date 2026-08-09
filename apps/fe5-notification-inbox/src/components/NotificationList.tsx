// NotificationList — renders InboxItem[] with LoadMore paging (no auto-fire),
// skeleton on first load, and empty/error states (FE5 §2-2, tests 1,2,14).

import type { ReactNode } from "react";
import { EmptyState, LoadMore, SkeletonLoader } from "../contracts/fe1";
import type { ApiError } from "../contracts/fe2";
import type { InboxItem } from "../contracts/notification-api";
import { NotificationListItem } from "./NotificationListItem";

export interface NotificationListProps {
  items: InboxItem[];
  hasMore: boolean;
  loading: boolean;
  error: ApiError | null;
  onActivate: (item: InboxItem) => void;
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
        action={{ label: "Retry", onClick: props.onRetry }}
        testId="fe5-inbox-error"
      />
    );
  }

  if (loading && items.length === 0) {
    return <SkeletonLoader rows={5} testId="fe5-inbox-skeleton" />;
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
    <div role="list" data-testid="fe5-inbox-list">
      {items.map((item) => (
        <div role="listitem" key={item.id}>
          <NotificationListItem item={item} onActivate={props.onActivate} />
        </div>
      ))}
      {hasMore ? (
        <LoadMore onClick={props.onLoadMore} loading={loading} testId="fe5-inbox-loadmore" />
      ) : null}
    </div>
  );
}
