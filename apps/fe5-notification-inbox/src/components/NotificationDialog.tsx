// NotificationDialog — the ONE shared notification modal. Opened from two entry
// points that both flip the shared dialog-store: the header bell and the shell
// Home "未読の通知" card. Reuses the existing inbox UI (useInbox + NotificationList
// + NotificationListItem: unread emphasis, click-to-read, 🎉 new-feature type
// badge) so there is a single source of truth for the list — no duplicate UI.
//
// Split in two so the inbox is fetched only while the dialog is open: the outer
// component subscribes to the store and mounts the body (which calls useInbox)
// lazily; when closed it renders nothing and no inbox request is made.

import { useCallback, useState, type ReactNode } from "react";
import { Button, Modal, SegmentedControl } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import { useInbox } from "../hooks/useInbox";
import { EMPTY_FILTER, type InboxSort } from "../lib/inbox-filter";
import { ROUTE_INBOX, resolveLinkUrl } from "../lib/routes";
import { useNotificationDialogStore } from "../store/dialog-store";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { NotificationList } from "./NotificationList";
import { itemLinkUrl } from "./NotificationListItem";

// The dialog is a *preview*, not the full inbox: it shows only the newest few
// items so the modal never grows tall enough to hide its own actions. Anything
// beyond this is reached via "すべての通知を見る" -> the full inbox page (which
// owns filtering + cursor paging). Keep small so no scroll is needed.
const DIALOG_PREVIEW_LIMIT = 3;

const SORT_OPTIONS: { value: InboxSort; label: string }[] = [
  { value: "newest", label: "新しい順" },
  { value: "oldest", label: "古い順" },
];

function NotificationDialogBody({ onClose }: { onClose: () => void }): ReactNode {
  const { navigate, toast } = useNotificationDeps();
  const [sort, setSort] = useState<InboxSort>("newest");
  const inbox = useInbox({ filter: { ...EMPTY_FILTER, sort } });

  const goToInbox = useCallback(() => {
    onClose();
    navigate(ROUTE_INBOX);
  }, [navigate, onClose]);

  const onActivate = useCallback(
    (item: InboxItem) => {
      void inbox.markRead(item.id); // optimistic read -> shared badge decrements
      const target = resolveLinkUrl(itemLinkUrl(item));
      onClose();
      if (target) {
        if (target.fellBack) toast.show("info", "Opening your inbox.");
        navigate(target.path);
      }
    },
    [inbox, navigate, toast, onClose],
  );

  // Preview only the newest few; the rest live on the full inbox page.
  const previewItems = inbox.items.slice(0, DIALOG_PREVIEW_LIMIT);
  const overflowCount = inbox.items.length - previewItems.length;
  const hasMoreThanPreview = inbox.hasMore || overflowCount > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="通知"
      size="md"
      testId="fe5-notif-dialog"
      footer={
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "space-between", width: "100%" }}>
          <MarkAllReadButton
            onClick={() => void inbox.markAllRead()}
            disabled={inbox.items.every((i) => i.readAt !== null)}
          />
          <Button
            variant="ghost"
            testId="fe5-notif-dialog-seeall"
            onClick={goToInbox}
          >
            すべての通知を見る
          </Button>
        </div>
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: "var(--dub-space-2)",
        }}
      >
        <SegmentedControl<InboxSort>
          options={SORT_OPTIONS}
          value={sort}
          onChange={setSort}
          size="sm"
          aria-label="並び順"
          testId="fe5-notif-dialog-sort"
        />
      </div>
      {/* Preview list: capped items, and the in-list "さらに読み込む" is suppressed
       * (hasMore=false) — paging happens on the full inbox page, not in here. */}
      <NotificationList
        items={previewItems}
        hasMore={false}
        loading={inbox.loading}
        error={inbox.error}
        onActivate={onActivate}
        onLoadMore={goToInbox}
        onRetry={() => void inbox.reload()}
        onMarkUnread={(item) => void inbox.markUnread(item.id)}
      />
      {hasMoreThanPreview ? (
        <div style={{ marginTop: "0.5rem", textAlign: "center" }}>
          <Button variant="ghost" testId="fe5-notif-dialog-more" onClick={goToInbox}>
            {overflowCount > 0
              ? `ほか ${overflowCount}${inbox.hasMore ? "+" : ""} 件をすべて見る`
              : "さらに読み込む（すべて見る）"}
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}

/** Store-driven wrapper: mounts the (fetching) body only while open. */
export function NotificationDialog(): ReactNode {
  const open = useNotificationDialogStore((s) => s.open);
  const closeDialog = useNotificationDialogStore((s) => s.closeDialog);
  if (!open) return null;
  return <NotificationDialogBody onClose={closeDialog} />;
}

export default NotificationDialog;
