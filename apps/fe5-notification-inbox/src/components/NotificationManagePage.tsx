// NotificationManagePage — the /notifications/manage route (admin only). Lists
// audience='admin' notifications and lets an admin publish them to members: one row at a
// time, OR in BULK — filter by genre, "すべて選択", then "メンバーへ一括公開" (one request).
// Skeleton loading; publishing is optimistic (rows flip to 公開済み instantly, roll back on
// failure). The shell gates this route on notif:broadcast_publish (admins/maintainers).

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonList,
  Stack,
  Tabs,
  type DisplayableError,
} from "@dub/ui";
import type { AdminNotificationItem } from "../contracts/notification-api";
import { useAdminNotifications } from "../hooks/useAdminNotifications";
import { NotificationTypeLabel } from "./NotificationTypeLabel";
import { NOTIFICATION_GROUP_META } from "../lib/type-dictionary";
import {
  availableCategories,
  categoryOf,
  filterByCategory,
  publishableIds,
  unpublishableIds,
  selectableIds,
  allSelected,
  type ManageFilter,
} from "../lib/manage-filter";

const ALL_TAB = "all";

function excerpt(body: string, max = 140): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function ManageRow(props: {
  item: AdminNotificationItem;
  selected: boolean;
  publishing: boolean;
  unpublishing: boolean;
  onToggle: (id: string) => void;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
}): ReactNode {
  const { item, selected, publishing, unpublishing, onToggle, onPublish, onUnpublish } = props;
  const published = item.publishedBroadcastId !== null;
  return (
    <Card padded testId="fe5-manage-item">
      <Stack direction="row" justify="between" align="start" gap={4}>
        <Stack gap={1}>
          <Checkbox
            id={`fe5-sel-${item.id}`}
            checked={selected}
            onChange={() => onToggle(item.id)}
            label={
              <span>
                <NotificationTypeLabel type={item.type} showLabel={false} /> <strong>{item.title}</strong>
              </span>
            }
            testId="fe5-manage-checkbox"
          />
          <span style={{ color: "var(--dub-color-fg-muted)", paddingInlineStart: "1.75rem" }}>
            <Badge tone="neutral">{NOTIFICATION_GROUP_META[categoryOf(item)].label}</Badge>{" "}
            {item.body ? excerpt(item.body) : ""}
          </span>
        </Stack>
        <div style={{ flexShrink: 0 }}>
          {published ? (
            <Stack direction="row" align="center" gap={2}>
              <Badge tone="success" testId="fe5-published-badge">
                公開済み
              </Badge>
              <Button
                variant="ghost"
                loading={unpublishing}
                disabled={unpublishing}
                onClick={() => onUnpublish(item.id)}
                testId="fe5-unpublish-btn"
              >
                公開解除
              </Button>
            </Stack>
          ) : (
            <Button
              variant="secondary"
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
  const { items, loading, error, publishing, unpublishing, publish, publishMany, unpublish, unpublishMany, reload } =
    useAdminNotifications();
  const [filter, setFilter] = useState<ManageFilter>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkUnpublishBusy, setBulkUnpublishBusy] = useState(false);

  const categories = useMemo(() => availableCategories(items), [items]);
  const filtered = useMemo(() => filterByCategory(items, filter), [items, filter]);
  const selectAllChecked = allSelected(filtered, selected);
  const selectedCount = selected.size;
  // Selection spans both states; each bulk button acts only on its applicable subset.
  const selectedPublishableCount = useMemo(
    () => publishableIds(filtered).filter((id) => selected.has(id)).length,
    [filtered, selected],
  );
  const selectedUnpublishableCount = useMemo(
    () => unpublishableIds(filtered).filter((id) => selected.has(id)).length,
    [filtered, selected],
  );

  // Changing the filter resets the selection (selection always reflects the visible set).
  const onFilterChange = useCallback((tabId: string) => {
    setFilter(tabId === ALL_TAB ? null : (tabId as ManageFilter));
    setSelected(new Set());
  }, []);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const ids = selectableIds(filtered);
    setSelected((prev) => {
      const everySelected = ids.length > 0 && ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (everySelected) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }, [filtered]);

  const onBulkPublish = useCallback(async () => {
    if (selectedPublishableCount === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await publishMany([...selected]);
      setSelected(new Set()); // published rows are no longer publishable
    } finally {
      setBulkBusy(false);
    }
  }, [selected, selectedPublishableCount, bulkBusy, publishMany]);

  const onBulkUnpublish = useCallback(async () => {
    if (selectedUnpublishableCount === 0 || bulkUnpublishBusy) return;
    setBulkUnpublishBusy(true);
    try {
      await unpublishMany([...selected]);
      setSelected(new Set()); // retracted rows are no longer unpublishable
    } finally {
      setBulkUnpublishBusy(false);
    }
  }, [selected, selectedUnpublishableCount, bulkUnpublishBusy, unpublishMany]);

  const displayError: DisplayableError | null = useMemo(
    () =>
      error
        ? { code: error.code, message: "通知一覧を読み込めませんでした", ...(error.requestId ? { correlationId: error.requestId } : {}) }
        : null,
    [error],
  );

  const tabs = useMemo(
    () => [
      { id: ALL_TAB, label: `すべて (${items.length})` },
      ...categories.map((c) => ({ id: c.value, label: `${c.label} (${c.count})` })),
    ],
    [items.length, categories],
  );

  return (
    <Stack gap={4} testId="fe5-manage-page">
      <PageHeader
        title="Notification管理"
        description="管理者向けの通知を確認し、「メンバーへ公開」でメンバー全体に配信します。公開済みの通知は「公開解除」でメンバーから取り下げられます。"
        testId="fe5-manage-header"
      />

      {!loading && !displayError && items.length > 0 ? (
        <Stack gap={3}>
          <Tabs items={tabs} activeId={filter ?? ALL_TAB} onChange={onFilterChange} testId="fe5-manage-filter" />
          <Card padded>
            <Stack direction="row" justify="between" align="center" gap={4}>
              <Stack direction="row" align="center" gap={3}>
                <Checkbox
                  id="fe5-select-all"
                  checked={selectAllChecked}
                  disabled={selectableIds(filtered).length === 0}
                  onChange={toggleSelectAll}
                  label="すべて選択"
                  testId="fe5-select-all"
                />
                <span data-testid="fe5-selected-count" style={{ color: "var(--dub-color-fg-muted)" }}>
                  {selectedCount}件選択中
                </span>
              </Stack>
              <Stack direction="row" align="center" gap={2}>
                <Button
                  variant="secondary"
                  loading={bulkUnpublishBusy}
                  disabled={selectedUnpublishableCount === 0 || bulkUnpublishBusy}
                  onClick={() => void onBulkUnpublish()}
                  testId="fe5-bulk-unpublish-btn"
                >
                  選択したものを公開解除
                </Button>
                <Button
                  variant="primary"
                  loading={bulkBusy}
                  disabled={selectedPublishableCount === 0 || bulkBusy}
                  onClick={() => void onBulkPublish()}
                  testId="fe5-bulk-publish-btn"
                >
                  メンバーへ一括公開
                </Button>
              </Stack>
            </Stack>
          </Card>
        </Stack>
      ) : null}

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
      ) : filtered.length === 0 ? (
        <EmptyState title="このジャンルの通知はありません" testId="fe5-manage-empty-filtered" />
      ) : (
        <Stack gap={3}>
          {filtered.map((item) => (
            <ManageRow
              key={item.id}
              item={item}
              selected={selected.has(item.id)}
              publishing={publishing.has(item.id)}
              unpublishing={unpublishing.has(item.id)}
              onToggle={toggleOne}
              onPublish={publish}
              onUnpublish={unpublish}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export default NotificationManagePage;
