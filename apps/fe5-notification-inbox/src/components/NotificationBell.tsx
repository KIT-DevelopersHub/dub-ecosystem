// NotificationBell — the ONLY external embed part (FE2 headerWidget slot).
// Unread badge (from useUnreadCount, the single source of truth) + a dropdown of
// recent items with "See all" -> /notifications (FE5 §2-2, tests 9,16).

import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button, IconButton, Popover, Spinner } from "../contracts/fe1";
import type { InboxItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import { useUnreadCount } from "../hooks/useUnreadCount";
import { ROUTE_INBOX, resolveLinkUrl } from "../lib/routes";
import { itemLinkUrl, NotificationListItem } from "./NotificationListItem";
import styles from "./NotificationBell.module.css";

const RECENT_LIMIT = 5;

export function NotificationBell(): ReactNode {
  const { api, navigate, toast } = useNotificationDeps();
  const { count, refresh } = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRecent = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listInbox({ limit: RECENT_LIMIT });
      setRecent(page.items);
    } catch {
      // silent — the bell degrades to the badge only.
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (open) void loadRecent();
  }, [open, loadRecent]);

  const onActivate = useCallback(
    (item: InboxItem) => {
      setOpen(false);
      const target = resolveLinkUrl(itemLinkUrl(item));
      void api.markRead(item.id).then(() => void refresh());
      if (target) {
        if (target.fellBack) toast.show("info", "Opening your inbox.");
        navigate(target.path);
      }
    },
    [api, navigate, refresh, toast],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className={styles.bell} onKeyDown={onKeyDown} data-testid="fe5-bell">
      <Popover
        open={open}
        onOpenChange={setOpen}
        testId="fe5-bell-popover"
        trigger={
          <span className={styles.bell}>
            <IconButton
              icon="bell"
              aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              testId="fe5-bell-button"
            />
            <span className={styles.badge}>
              <Badge count={count} testId="fe5-bell-badge" aria-label={`${count} unread notifications`} />
            </span>
          </span>
        }
      >
        <div className={styles.dropdownHeader}>
          <span>Notifications</span>
        </div>
        {loading ? (
          <Spinner testId="fe5-bell-spinner" />
        ) : recent.length === 0 ? (
          <p data-testid="fe5-bell-empty">No notifications</p>
        ) : (
          <div role="list" data-testid="fe5-bell-list">
            {recent.map((item) => (
              <div role="listitem" key={item.id}>
                <NotificationListItem item={item} onActivate={onActivate} />
              </div>
            ))}
          </div>
        )}
        <div className={styles.footer}>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              navigate(ROUTE_INBOX);
            }}
            testId="fe5-bell-seeall"
          >
            See all
          </Button>
        </div>
      </Popover>
    </div>
  );
}

export default NotificationBell;
