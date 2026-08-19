// NotificationList — renders InboxItem[] grouped by app/type (per-app sections with a
// header + unread count), LoadMore paging (no auto-fire), skeleton on first load, and
// empty/error states (FE5 §2-2, tests 1,2,14). Grouping keeps the list from flattening
// into one undifferentiated stream while every item stays a role="listitem".

import type { ReactNode } from "react";
import { Badge, Button, EmptyState, Icon, LoadMore, SkeletonLoader } from "@dub/ui";
import type { IconName } from "@dub/ui";
import type { ApiError } from "../contracts/fe2";
import type { InboxItem } from "../contracts/notification-api";
import { NotificationListItem } from "./NotificationListItem";
import { groupInboxItems } from "../lib/group-inbox";
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

  const groups = groupInboxItems(items);

  return (
    <div role="list" data-testid="fe5-inbox-list">
      {groups.map((g) => (
        <section
          className={styles.section}
          key={g.group}
          data-group={g.group}
          data-testid={`fe5-inbox-group-${g.group}`}
          aria-label={g.label}
        >
          <div className={styles.header}>
            <Icon name={g.icon as IconName} size="sm" aria-hidden="true" />
            <span className={styles.headerLabel}>{g.label}</span>
            {g.unread > 0 ? (
              <Badge tone="brand" testId={`fe5-inbox-group-unread-${g.group}`}>
                未読 {g.unread}
              </Badge>
            ) : null}
          </div>
          {g.items.map((item) => (
            <div role="listitem" key={item.id}>
              <NotificationListItem
                item={item}
                onActivate={props.onActivate}
                {...(props.onMarkUnread ? { onMarkUnread: props.onMarkUnread } : {})}
              />
            </div>
          ))}
        </section>
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
