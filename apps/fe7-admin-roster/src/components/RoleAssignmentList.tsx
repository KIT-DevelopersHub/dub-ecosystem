import { useState } from "react";
import { DataTable, Badge, Button, ConfirmDialog, EmptyState, type ColumnDef } from "@dub/ui";
import { useUserRoles, useRevokeRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import type { RoleAssignment } from "../contracts/pending";

export function RoleAssignmentList({ userId }: { userId: string }) {
  const assignments = useUserRoles(userId);
  const revoke = useRevokeRole(userId);
  const { can } = usePermissions();
  const [pending, setPending] = useState<RoleAssignment | null>(null);
  const canAdmin = can("identity:admin");

  // Row identity testid surfaced on the first cell (@dub/ui DataTable has no rowTestId).
  const columns: ColumnDef<RoleAssignment>[] = [
    { key: "role", header: "ロール", cell: (a) => <span data-testid={`fe7-assignment-row-${a.id}`}>{a.roleName}</span> },
    {
      key: "scope",
      header: "スコープ",
      cell: (a) =>
        a.resourceType === "event"
          ? <Badge tone="neutral">event: {a.resourceId}</Badge>
          : <Badge tone="success">組織全体</Badge>,
    },
    { key: "grantedBy", header: "付与者", cell: (a) => a.grantedBy },
    {
      key: "actions",
      header: "",
      cell: (a) =>
        canAdmin ? <Button variant="danger" onClick={() => setPending(a)} testId={`fe7-roles-revoke-${a.id}`}>剥奪</Button> : null,
    },
  ];

  if (assignments.data && assignments.data.length === 0) {
    return <EmptyState title="割り当てられたロールはありません" testId="fe7-assignments-empty" />;
  }

  return (
    <div>
      <DataTable
        columns={columns}
        rows={assignments.data ?? []}
        rowKey={(a) => a.id}
        stickyHeader
        zebra
        testId="fe7-assignments-table"
      />
      <ConfirmDialog
        title="ロールを剥奪"
        message={`「${pending?.roleName}」を剥奪します。組織内で最後の管理者の場合はサーバ側で拒否されます。`}
        open={pending !== null}
        danger
        confirmLabel="剥奪する"
        onConfirm={() => { if (pending) revoke.mutate(pending.id, { onSettled: () => setPending(null) }); }}
        onCancel={() => setPending(null)}
        testId="fe7-assignment-revoke-confirm"
      />
    </div>
  );
}
