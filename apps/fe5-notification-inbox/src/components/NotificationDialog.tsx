// NotificationDialog — the ONE shared notification modal. Opened from two entry
// points that both flip the shared dialog-store: the header bell and the shell
// Home "未読の通知" card. Reuses the existing inbox UI (useInbox + NotificationList
// + NotificationListItem: unread emphasis, click-to-read, 🎉 new-feature type
// badge) so there is a single source of truth for the list — no duplicate UI.
//
// Split in two so the inbox is fetched only while the dialog is open: the outer
// component subscribes to the store and mounts the body (which calls useInbox)
// lazily; when closed it renders nothing and no inbox request is made.

import { useCallback, type ReactNode } from "react";
import { Button, Modal } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { useNotificationDeps } from "../context";
import { useInbox } from "../hooks/useInbox";
import { EMPTY_FILTER } from "../lib/inbox-filter";
import { ROUTE_INBOX, resolveLinkUrl } from "../lib/routes";
import { useNotificationDialogStore } from "../store/dialog-store";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { NotificationList } from "./NotificationList";
import { itemLinkUrl } from "./NotificationListItem";

function NotificationDialogBody({ onClose }: { onClose: () => void }): ReactNode {
  const { navigate, toast } = useNotificationDeps();
  const inbox = useInbox({ filter: EMPTY_FILTER });

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
            onClick={() => {
              onClose();
              navigate(ROUTE_INBOX);
            }}
          >
            すべての通知を見る
          </Button>
        </div>
      }
    >
      <NotificationList
        items={inbox.items}
        hasMore={inbox.hasMore}
        loading={inbox.loading}
        error={inbox.error}
        onActivate={onActivate}
        onLoadMore={() => void inbox.loadMore()}
        onRetry={() => void inbox.reload()}
      />
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
