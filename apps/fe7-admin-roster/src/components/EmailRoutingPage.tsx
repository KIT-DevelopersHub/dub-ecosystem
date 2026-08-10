import { useState } from "react";
import {
  PageHeader,
  DataTable,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  type ColumnDef,
} from "@dub/ui";
import type { EmailRoutingAddress } from "../contracts/pending";
import { useEmailAddresses, useUpdateEmailAddress, useDeleteEmailAddress } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { NewEmailAddressDialog } from "./NewEmailAddressDialog";
import { displayError } from "../lib/errorDisplay";

// メールアドレス管理 — Cloudflare Email Routing @developershub.jp addresses:
// list / issue / enable-disable / delete. Same layout family as ロール管理 /
// ユーザー名簿; admin surface (gated by mail:admin on the route + launcher).
export function EmailRoutingPage() {
  const list = useEmailAddresses();
  const update = useUpdateEmailAddress();
  const del = useDeleteEmailAddress();
  const { can } = usePermissions();
  const canManage = can("mail:admin");

  const [newOpen, setNewOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EmailRoutingAddress | null>(null);

  const columns: ColumnDef<EmailRoutingAddress>[] = [
    {
      key: "address",
      header: "アドレス",
      cell: (a) => <span data-testid={`fe7-email-row-${a.id}`}>{a.address}</span>,
    },
    { key: "destination", header: "転送先", cell: (a) => a.destination },
    {
      key: "status",
      header: "状態",
      cell: (a) =>
        a.enabled ? (
          <Badge tone="success" testId={`fe7-email-status-${a.id}`}>
            有効
          </Badge>
        ) : (
          <Badge tone="neutral" testId={`fe7-email-status-${a.id}`}>
            無効
          </Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (a) =>
        canManage ? (
          <span style={{ display: "flex", gap: 8 }}>
            <Button
              variant="secondary"
              onClick={() => update.mutate({ id: a.id, req: { enabled: !a.enabled } })}
              disabled={update.isPending}
              testId={`fe7-email-toggle-${a.id}`}
            >
              {a.enabled ? "無効にする" : "有効にする"}
            </Button>
            <Button variant="danger" onClick={() => setPendingDelete(a)} testId={`fe7-email-delete-${a.id}`}>
              削除
            </Button>
          </span>
        ) : null,
    },
  ];

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete.id, { onSettled: () => setPendingDelete(null) });
  }

  return (
    <div>
      <PageHeader
        title="メールアドレス管理"
        testId="fe7-email-header"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setNewOpen(true)} testId="fe7-email-new">
              メールアドレスを発行
            </Button>
          ) : null
        }
      />
      {list.isError ? (
        <ErrorState error={displayError(list.error)} onRetry={() => list.refetch()} testId="fe7-email-error" />
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title="発行済みのアドレスがありません" testId="fe7-email-empty" />
      ) : (
        <DataTable columns={columns} rows={list.data?.items ?? []} rowKey={(a) => a.id} testId="fe7-email-table" />
      )}

      <NewEmailAddressDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ConfirmDialog
        title="アドレスを削除"
        message={`「${pendingDelete?.address}」を削除します。転送ルールも解除されます。よろしいですか？`}
        open={pendingDelete !== null}
        danger
        confirmLabel="削除する"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
        testId="fe7-email-delete-confirm"
      />
    </div>
  );
}
