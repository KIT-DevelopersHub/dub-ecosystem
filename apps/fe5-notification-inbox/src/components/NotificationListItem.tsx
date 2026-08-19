// NotificationListItem — one inbox row. Clicking the row marks read + navigates to
// the resolved linkUrl (FE5 §2-2, test 8). Unread rows carry a dot + aria state.
//
// When `onMarkUnread` is supplied, a read row also exposes a trailing "未読にする"
// action (restore to unread — the inverse of click-to-read). It is a small ghost
// button with an ALWAYS-VISIBLE text label (not an icon-only/hover-tooltip control):
// text-primary on the surface reads at high contrast, so the affordance is legible and
// discoverable. The row is a container <div> (not a single <button>) so the action is a
// real sibling button and interactive controls are never nested; it reserves its own
// trailing cell, so it never shifts the row layout.

import type { KeyboardEvent, ReactNode } from "react";
import { Badge, Button, Icon } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { resolveCategory, NOTIFICATION_CATEGORY_META } from "../lib/type-dictionary";
import { formatRelativeTime } from "../lib/relative-time";
import styles from "./NotificationListItem.module.css";

export interface NotificationListItemProps {
  item: InboxItem;
  onActivate: (item: InboxItem) => void;
  /** Optional: when provided, read rows expose a quiet "未読にする" action (restore to unread). */
  onMarkUnread?: (item: InboxItem) => void;
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
  const { item, onActivate, onMarkUnread } = props;
  const unread = item.readAt === null;
  const category = resolveCategory(item.type);
  const categoryMeta = NOTIFICATION_CATEGORY_META[category];
  // A read row can be restored to unread (Gmail-style quiet trailing toggle).
  const canMarkUnread = !unread && onMarkUnread !== undefined;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(item);
    }
  };
  return (
    <div className={styles.row} data-testid={`fe5-inbox-row-${item.id}`}>
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
            <Badge
              tone={categoryMeta.tone}
              testId={`fe5-inbox-cat-badge-${category}`}
            >
              {categoryMeta.label}
            </Badge>
            <span>{formatRelativeTime(item.createdAt)}</span>
          </div>
        </div>
      </button>
      {canMarkUnread ? (
        <div className={styles.trailing}>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="inbox" size="sm" aria-hidden="true" />}
            className={styles.markUnread}
            testId={`fe5-inbox-markunread-${item.id}`}
            onClick={() => onMarkUnread?.(item)}
          >
            未読にする
          </Button>
        </div>
      ) : null}
    </div>
  );
}
