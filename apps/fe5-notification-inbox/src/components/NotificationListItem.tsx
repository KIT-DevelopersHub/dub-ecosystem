// NotificationListItem — one inbox row. Clean, full-width, and compact (Gmail-style):
// title + one-line snippet, with a trailing cell that shows the timestamp and — on
// hover/focus — swaps to ONE quiet read/unread toggle icon (mirrors the mail Gmail
// clone's row-hover pattern). Clicking the row marks read + navigates to the resolved
// linkUrl (FE5 §2-2, test 8). Unread rows carry a dot + aria state.
//
// The toggle direction follows the row's read state: a read row offers "未読にする"
// (onMarkUnread), an unread row offers "既読にする" (onMarkRead). It is a DS IconButton
// (properly styled, no default UA border) stacked with the timestamp in one grid cell,
// so it reserves NO extra width and never shifts the layout.
//
// The row is a container <div> (not a <button>) so the toggle can be a real button
// without nesting interactive controls: the main clickable area is its own button, the
// toggle is a sibling in the trailing cell.

import type { KeyboardEvent, ReactNode } from "react";
import { Badge, IconButton, Tooltip } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { resolveTypeDisplay } from "../lib/type-dictionary";
import { formatRelativeTime } from "../lib/relative-time";
import styles from "./NotificationListItem.module.css";

export interface NotificationListItemProps {
  item: InboxItem;
  onActivate: (item: InboxItem) => void;
  /** Optional: when provided, read rows expose a quiet "未読にする" action (restore to unread). */
  onMarkUnread?: (item: InboxItem) => void;
  /** Optional: when provided, unread rows expose a quiet "既読にする" action (mark read in place). */
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
  // One quiet trailing toggle; direction depends on the row's read state (Gmail-style):
  // a read row offers "未読にする"; an unread row offers "既読にする".
  const toggle =
    !unread && onMarkUnread
      ? {
          icon: "inbox" as const,
          label: "未読にする",
          testId: `fe5-inbox-markunread-${item.id}`,
          run: () => onMarkUnread(item),
        }
      : unread && onMarkRead
        ? {
            icon: "check" as const,
            label: "既読にする",
            testId: `fe5-inbox-markread-${item.id}`,
            run: () => onMarkRead(item),
          }
        : null;
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
          <div className={styles.titleRow}>
            {isRelease ? (
              <Badge tone="brand" testId="fe5-inbox-release-badge">
                🎉 新機能
              </Badge>
            ) : null}
            <span className={styles.title}>{item.title}</span>
          </div>
          <div className={styles.snippet}>{item.body}</div>
        </div>
      </button>
      <div className={styles.trailing}>
        <span className={styles.time}>{formatRelativeTime(item.createdAt)}</span>
        {toggle ? (
          <span className={styles.action}>
            <Tooltip content={toggle.label}>
              <IconButton
                name={toggle.icon}
                size="sm"
                variant="ghost"
                aria-label={`${toggle.label}: ${item.title}`}
                testId={toggle.testId}
                onClick={toggle.run}
              />
            </Tooltip>
          </span>
        ) : null}
      </div>
    </div>
  );
}
