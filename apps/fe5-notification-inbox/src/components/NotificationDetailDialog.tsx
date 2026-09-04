// NotificationDetailDialog — full-text / detail view of ONE inbox notification.
// Opened when a row is activated (FB: 一覧では本文が途中で切れて全文が読めない / 差出人が
// 分からない). Built on the shared @dub/ui Modal, so it inherits the overlay-click +
// Esc close, focus trap and body scroll-lock. Long bodies scroll inside the dialog.

import type { ReactNode } from "react";
import { Modal, Button, Stack } from "@dub/ui";
import type { InboxItem } from "../contracts/notification-api";
import { NotificationTypeLabel } from "./NotificationTypeLabel";
import { itemActorName } from "./NotificationCard";
import styles from "./NotificationDetailDialog.module.css";

// Absolute timestamp — the full view wants the exact date/time, not the "3h" relative
// form used in the compact list row.
function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface NotificationDetailDialogProps {
  // The item to show; null closes the dialog.
  item: InboxItem | null;
  onClose: () => void;
  // Present only when the item resolves to an in-app link; invoking it navigates
  // (and the caller closes the dialog).
  onOpenLink?: (() => void) | undefined;
}

export function NotificationDetailDialog(props: NotificationDetailDialogProps): ReactNode {
  const { item, onClose, onOpenLink } = props;
  const sender = item ? itemActorName(item) : null;
  return (
    <Modal
      open={item !== null}
      onClose={onClose}
      title={item?.title ?? ""}
      size="md"
      testId="fe5-notif-detail-dialog"
      footer={
        <div className={styles.footer}>
          {onOpenLink ? (
            <Button variant="primary" onClick={onOpenLink} testId="fe5-notif-detail-open">
              リンク先を開く
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} testId="fe5-notif-detail-close">
            閉じる
          </Button>
        </div>
      }
    >
      {item ? (
        <Stack gap={4}>
          <dl className={styles.meta}>
            <div className={styles.metaRow}>
              <dt className={styles.metaLabel}>種別</dt>
              <dd className={styles.metaValue}>
                <NotificationTypeLabel type={item.type} />
              </dd>
            </div>
            {sender ? (
              <div className={styles.metaRow}>
                <dt className={styles.metaLabel}>差出人</dt>
                <dd className={styles.metaValue} data-testid="fe5-notif-detail-sender">
                  {sender}
                </dd>
              </div>
            ) : null}
            <div className={styles.metaRow}>
              <dt className={styles.metaLabel}>日時</dt>
              <dd className={styles.metaValue}>{formatDateTime(item.createdAt)}</dd>
            </div>
          </dl>
          <div className={styles.body} data-testid="fe5-notif-detail-body">
            {item.body}
          </div>
        </Stack>
      ) : null}
    </Modal>
  );
}

export default NotificationDetailDialog;
