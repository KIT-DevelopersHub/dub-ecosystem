import { useState } from "react";
import type { identity } from "@dub/types";
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
import { useRoles, useDeleteRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { errorMessage, displayError } from "../lib/errorDisplay";

export function RoleListPage({ onEdit, onNew }: { onEdit?: (id: string) => void; onNew?: () => void }) {
  const roles = useRoles();
  const del = useDeleteRole();
  const { can } = usePermissions();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<identity.Role | null>(null);
  const canAdmin = can("identity:admin");

  // Row identity testid surfaced on the first cell (@dub/ui DataTable has no rowTestId).
  const columns: ColumnDef<identity.Role>[] = [
    {
      key: "name",
      header: "ロール",
      cell: (r) => (
        <span data-testid={`fe7-roles-row-${r.id}`}>
          {onEdit ? (
            <button onClick={() => onEdit(r.id)} data-testid={`fe7-roles-open-${r.id}`}>
              {r.name}
            </button>
          ) : (
            r.name
          )}
        </span>
      ),
    },
    {
      key: "system",
      header: "種別",
      cell: (r) =>
        r.isSystem ? (
          <Badge tone="neutral" testId={`fe7-roles-system-${r.id}`}>
            システム
          </Badge>
        ) : (
          <Badge tone="success">カスタム</Badge>
        ),
    },
    { key: "perms", header: "権限数", cell: (r) => `${r.permissions.length} 権限` },
    {
      key: "actions",
      header: "",
      cell: (r) =>
        canAdmin && !r.isSystem ? (
          <Button variant="danger" onClick={() => setPendingDelete(r)} testId={`fe7-roles-delete-${r.id}`}>
            削除
          </Button>
        ) : null,
    },
  ];

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete.id, {
      onSuccess: () => { toast({ kind: "success", title: "ロールを削除しました" }); setPendingDelete(null); },
      onError: (err) => { toast({ kind: "error", title: "削除に失敗しました", description: errorMessage(err) }); setPendingDelete(null); },
    });
  }

  return (
    <div>
      <PageHeader
        title="ロール管理"
        testId="fe7-roles-header"
        actions={canAdmin ? <Button variant="primary" onClick={onNew} testId="fe7-roles-new">ロールを作成</Button> : null}
      />
      {roles.isError ? (
        <ErrorState error={displayError(roles.error)} onRetry={() => roles.refetch()} testId="fe7-roles-error" />
      ) : roles.data && roles.data.items.length === 0 ? (
        <EmptyState title="ロールがありません" testId="fe7-roles-empty" />
      ) : (
        <DataTable columns={columns} rows={roles.data?.items ?? []} rowKey={(r) => r.id} testId="fe7-roles-table" />
      )}
      <ConfirmDialog
        title="ロールを削除"
        message={`「${pendingDelete?.name}」を削除します。よろしいですか？`}
        open={pendingDelete !== null}
        danger
        confirmLabel="削除する"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
        testId="fe7-roles-delete-confirm"
      />
    </div>
  );
}
