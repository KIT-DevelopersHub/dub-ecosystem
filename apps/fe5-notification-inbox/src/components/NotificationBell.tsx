// NotificationBell — the header notification control (FE2 headerWidget slot).
// Renders the unread badge (from useUnreadCount, the single source of truth) and,
// on click, opens the SHARED notification dialog (the same modal the Home
// "未読の通知" card opens). The dialog itself is rendered here so it lives inside
// the NotificationProvider context on every authenticated page.

import { type ReactNode } from "react";
import { Icon } from "@dub/ui";
import { useUnreadCount } from "../hooks/useUnreadCount";
import { openNotificationDialog } from "../store/dialog-store";
import { NotificationDialog } from "./NotificationDialog";
import styles from "./NotificationBell.module.css";

export function NotificationBell(): ReactNode {
  const { count } = useUnreadCount();

  return (
    <div className={styles.bellRoot} data-testid="fe5-bell">
      <button
        type="button"
        className={styles.bellButton}
        data-testid="fe5-bell-button"
        aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
        onClick={() => openNotificationDialog()}
      >
        <Icon name="bell" aria-hidden="true" />
        {count > 0 ? (
          <span className={styles.badge} data-testid="fe5-bell-badge" aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      <NotificationDialog />
    </div>
  );
}

export default NotificationBell;
