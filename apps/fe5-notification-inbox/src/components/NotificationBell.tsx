// NotificationBell — the header notification control (FE2 headerWidget slot).
// Renders the unread badge (from useUnreadCount, the single source of truth) and,
// on click, opens the SHARED notification dialog (the same modal the Home
// "未読の通知" card opens). The dialog itself is rendered here so it lives inside
// the NotificationProvider context on every authenticated page.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "@dub/ui";
import { useUnreadCount } from "../hooks/useUnreadCount";
import { openNotificationDialog } from "../store/dialog-store";
import { NotificationDialog } from "./NotificationDialog";
import styles from "./NotificationBell.module.css";

export function NotificationBell(): ReactNode {
  const { count } = useUnreadCount();

  // A04: pulse the badge only when the unread count *increases* (a fresh arrival).
  // A decrease (marking read) never pulses, and re-renders that leave the count
  // unchanged never pulse (we compare against the previous value in a ref).
  //
  // Initial load must NOT pulse — including the async hydration of *pre-existing*
  // unread (e.g. count settles 0 → 2 after the first fetch). We therefore ignore
  // increases during a short hydration window after mount, only advancing the
  // baseline; after it, genuine arrivals bump `pulseKey`, which remounts the
  // badge so the CSS keyframe replays from the start.
  const HYDRATION_MS = 800;
  const prevCount = useRef(count);
  const ready = useRef(false);
  const [pulseKey, setPulseKey] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      ready.current = true;
    }, HYDRATION_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!ready.current) {
      prevCount.current = count; // adopt hydrated value as baseline, no pulse
      return;
    }
    if (count > prevCount.current) setPulseKey((k) => k + 1);
    prevCount.current = count;
  }, [count]);

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
          <span
            key={pulseKey}
            className={pulseKey > 0 ? `${styles.badge} ${styles.pulse}` : styles.badge}
            data-testid="fe5-bell-badge"
            aria-hidden="true"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      <NotificationDialog />
    </div>
  );
}

export default NotificationBell;
