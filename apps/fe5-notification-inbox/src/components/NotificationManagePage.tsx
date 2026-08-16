// NotificationManagePage — the /notifications/manage route (admin only). Lists
// audience='admin' notifications (deploy done / feature published / feedback) and lets an
// admin publish any of them to ALL members with a single click. Skeleton UI while
// loading; the publish action is optimistic (the row flips to "公開済み" instantly and
// rolls back on failure). The shell gates this route on notif:broadcast_publish, so it
// only renders for admins/maintainers.

import { useMemo, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonList,
  Stack,
  type DisplayableError,
} from "@dub/ui";
import type { AdminNotificationItem } from "../contracts/notification-api";
import { useAdminNotifications } from "../hooks/useAdminNotifications";
import { NotificationTypeLabel } from "./NotificationTypeLabel";

function excerpt(body: string, max = 140): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function ManageRow(props: {
  item: AdminNotificationItem;
  publishing: boolean;
  onPublish: (id: string) => void;
}): ReactNode {
  const { item, publishing, onPublish } = props;
  const published = item.publishedBroadcastId !== null;
  return (
    <Card padded testId="fe5-manage-item">
      <Stack direction="row" justify="between" align="start" gap={4}>
        <Stack gap={1}>
          <NotificationTypeLabel type={item.type} />
          <strong>{item.title}</strong>
          {item.body ? <span style={{ color: "var(--dub-color-fg-muted)" }}>{excerpt(item.body)}</span> : null}
        </Stack>
        <div style={{ flexShrink: 0 }}>
          {published ? (
            <Badge tone="success" testId="fe5-published-badge">
              公開済み
            </Badge>
          ) : (
            <Button
              variant="primary"
              loading={publishing}
              disabled={publishing}
              onClick={() => onPublish(item.id)}
              testId="fe5-publish-btn"
            >
              メンバーへ公開
            </Button>
          )}
        </div>
      </Stack>
    </Card>
  );
}

export function NotificationManagePage(): ReactNode {
  const { items, loading, error, publishing, publish, reload } = useAdminNotifications();

  const displayError: DisplayableError | null = useMemo(
    () =>
      error
        ? { code: error.code, message: "通知一覧を読み込めませんでした", ...(error.requestId ? { correlationId: error.requestId } : {}) }
        : null,
    [error],
  );

  return (
    <Stack gap={4} testId="fe5-manage-page">
      <PageHeader
        title="Notification管理"
        description="管理者向けの通知を確認し、「メンバーへ公開」で同じ内容をメンバー全体に配信します。"
        testId="fe5-manage-header"
      />
      {loading && items.length === 0 ? (
        <SkeletonList rows={4} testId="fe5-manage-skeleton" />
      ) : displayError ? (
        <ErrorState error={displayError} onRetry={() => void reload()} testId="fe5-manage-error" />
      ) : items.length === 0 ? (
        <EmptyState
          title="管理対象の通知はありません"
          description="デプロイ完了・新機能公開・フィードバックなどの管理者向け通知がここに表示されます。"
          testId="fe5-manage-empty"
        />
      ) : (
        <Stack gap={3}>
          {items.map((item) => (
            <ManageRow key={item.id} item={item} publishing={publishing.has(item.id)} onPublish={publish} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export default NotificationManagePage;
