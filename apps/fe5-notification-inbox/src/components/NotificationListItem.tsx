// NotificationListItem — one inbox row. Click marks read + navigates to the
// resolved linkUrl (FE5 §2-2, test 8). Unread rows carry a dot + aria state.

import type { KeyboardEvent, ReactNode } from "react";
import type { InboxItem } from "../contracts/notification-api";
import { NotificationTypeLabel } from "./NotificationTypeLabel";
import { formatRelativeTime } from "../lib/relative-time";
import styles from "./NotificationListItem.module.css";

export interface NotificationListItemProps {
  item: InboxItem;
  onActivate: (item: InboxItem) => void;
}

// Derive the in-app link target from the item's resource fields.
export function itemLinkUrl(item: InboxItem): string | null {
  if (!item.resourceType || !item.resourceId) return null;
  switch (item.resourceType) {
    case "task":
      return `/tasks/${item.resourceId}`;
    case "event":
      return `/events/${item.resourceId}`;
    case "file":
      return `/files/${item.resourceId}`;
    default:
      return null;
  }
}

export function NotificationListItem(props: NotificationListItemProps): ReactNode {
  const { item, onActivate } = props;
  const unread = item.readAt === null;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(item);
    }
  };
  return (
    <button
      type="button"
      className={`${styles.item} ${unread ? styles.unread : ""}`}
      data-testid={`fe5-inbox-item-${item.id}`}
      data-unread={unread}
      aria-label={`${unread ? "Unread. " : ""}${item.title}`}
      onClick={() => onActivate(item)}
      onKeyDown={onKeyDown}
    >
      {unread ? <span className={styles.dot} data-testid="fe5-inbox-unread-dot" aria-hidden="true" /> : null}
      <div className={styles.body}>
        <div className={styles.title}>{item.title}</div>
        <div className={styles.snippet}>{item.body}</div>
        <div className={styles.meta}>
          <NotificationTypeLabel type={item.type} />
          <span>{formatRelativeTime(item.createdAt)}</span>
        </div>
      </div>
    </button>
  );
}
