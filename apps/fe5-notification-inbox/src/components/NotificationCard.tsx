// NotificationCard — the SINGLE, canonical notification card. Rendered everywhere a
// notification row appears: the /notifications inbox list AND the header-bell / Home
// "未読の通知" dropdown (both go through NotificationList). One definition = one look,
// no drift. Presentational + data-injected (an InboxItem + handlers); it never fetches.
//
// Layout (tokens only — see NotificationCard.module.css):
//   line 1: [unread dot] title …………………… time (top-right)
//   line 2: one/two-line body snippet
// The genre is shown by the inbox tabs, not by a per-card tag, so the card is clean and
// naturally short while keeping the rounded-card / shadow / hover-lift / unread polish.
//
// Clicking the card marks read + navigates (onActivate). A read card also exposes a
// trailing "未読にする" action (onMarkUnread) — a real sibling <button> with an
// always-visible label, so interactive controls are never nested and the affordance
// stays legible.

import type { KeyboardEvent, ReactNode } from "react";
import { Button, Icon } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { formatRelativeTime } from "../lib/relative-time";
import styles from "./NotificationCard.module.css";

export interface NotificationCardProps {
  item: InboxItem;
  onActivate: (item: InboxItem) => void;
  /** Optional: when provided, read cards expose a quiet "未読にする" action (restore to unread). */
  onMarkUnread?: (item: InboxItem) => void;
}

// The human sender behind a notification (feedback submitter etc.): the resolved
// display name when identity supplied one, otherwise the raw actor id, otherwise null
// (no actor). Lets the card + detail dialog show "誰から" instead of an opaque id.
export function itemActorName(item: InboxItem): string | null {
  return item.actorName ?? item.actorId ?? null;
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

export function NotificationCard(props: NotificationCardProps): ReactNode {
  const { item, onActivate, onMarkUnread } = props;
  const unread = item.readAt === null;
  const sender = itemActorName(item);
  // A read card can be restored to unread (quiet trailing action).
  const canMarkUnread = !unread && onMarkUnread !== undefined;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(item);
    }
  };
  return (
    <div
      className={`${styles.row} ${unread ? styles.unread : ""}`}
      data-testid={`fe5-inbox-row-${item.id}`}
    >
      <button
        type="button"
        className={styles.item}
        data-testid={`fe5-inbox-item-${item.id}`}
        data-unread={unread}
        aria-label={`${unread ? "Unread. " : ""}${item.title}`}
        onClick={() => onActivate(item)}
        onKeyDown={onKeyDown}
      >
        {unread ? <span className={styles.dot} data-testid="fe5-inbox-unread-dot" aria-hidden="true" /> : null}
        <div className={styles.body}>
          <div className={styles.line1}>
            <span className={styles.title}>{item.title}</span>
            <span className={styles.time}>{formatRelativeTime(item.createdAt)}</span>
          </div>
          {sender ? (
            <div className={styles.sender} data-testid={`fe5-inbox-item-sender-${item.id}`}>
              差出人: {sender}
            </div>
          ) : null}
          <div className={styles.snippet}>{item.body}</div>
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
