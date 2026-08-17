// NotificationListItem — one COMPACT inbox row (Gmail-style density: title + time
// on one line, a single-line snippet below, unread dot). Click marks read + navigates
// to the resolved linkUrl (FE5 §2-2, test 8).
//
// Read/unread toggle — Gmail behaviour: the action is NOT rendered in the row's flow.
// It is an overlay chip pinned to the right edge that stays hidden (opacity 0, no
// reserved space) until the row is hovered/focused, then appears over the timestamp.
// It toggles both directions — an unread row offers "既読にする" (onMarkRead), a read
// row offers "未読にする" (onMarkUnread).
//
// The row is a container <div> (not a <button>) so the overlay action can be a real
// button without nesting interactive controls: the main clickable area is its own
// button, the action is a sibling laid over it.

import type { KeyboardEvent, ReactNode } from "react";
import { Badge } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { resolveTypeDisplay } from "../lib/type-dictionary";
import { formatRelativeTime } from "../lib/relative-time";
import styles from "./NotificationListItem.module.css";

export interface NotificationListItemProps {
  item: InboxItem;
  onActivate: (item: InboxItem) => void;
  /** Optional: when provided, read rows reveal a hover "未読にする" action (restore to unread). */
  onMarkUnread?: (item: InboxItem) => void;
  /** Optional: when provided, unread rows reveal a hover "既読にする" action (mark read in place). */
  onMarkRead?: (item: InboxItem) => void;
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
  const { item, onActivate, onMarkUnread, onMarkRead } = props;
  const unread = item.readAt === null;
  const isRelease = resolveTypeDisplay(item.type).group === "release";
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
        {unread ? (
          <span className={styles.dot} data-testid="fe5-inbox-unread-dot" aria-hidden="true" />
        ) : (
          <span className={styles.dotSpacer} aria-hidden="true" />
        )}
        <div className={styles.body}>
          <div className={styles.topline}>
            {isRelease ? (
              <Badge tone="brand" testId="fe5-inbox-release-badge">
                🎉 新機能
              </Badge>
            ) : null}
            <span className={styles.title}>{item.title}</span>
            <span className={styles.time}>{formatRelativeTime(item.createdAt)}</span>
          </div>
          <div className={styles.snippet}>{item.body}</div>
        </div>
      </button>
      {onMarkRead && unread ? (
        <button
          type="button"
          className={styles.action}
          data-testid={`fe5-inbox-markread-${item.id}`}
          aria-label={`既読にする: ${item.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead(item);
          }}
        >
          既読にする
        </button>
      ) : null}
      {onMarkUnread && !unread ? (
        <button
          type="button"
          className={styles.action}
          data-testid={`fe5-inbox-markunread-${item.id}`}
          aria-label={`未読にする: ${item.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onMarkUnread(item);
          }}
        >
          未読にする
        </button>
      ) : null}
    </div>
  );
}
