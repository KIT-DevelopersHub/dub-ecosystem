import { useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, Badge, Button, ConfirmDialog, EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import { useRoles, useDeleteRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { RolePermissionsEditor } from "./RolePermissionsEditor";
import { errorMessage, displayError } from "../lib/errorDisplay";

// Single-screen role management: each role expands IN PLACE to reveal its permission
// matrix (view + edit + save) — no navigation to a second "role editor" screen. One
// role is open at a time so the shared matrix testids never collide on the page.
const listStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #d0d7de)",
  borderRadius: 8,
  overflow: "hidden",
};
const headerRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: 12 };
const toggleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: 1,
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  textAlign: "left",
};
const nameStyle: React.CSSProperties = { fontWeight: 600 };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 13 };
const bodyStyle: React.CSSProperties = {
  padding: 12,
  borderTop: "1px solid var(--dub-color-border-default, #d0d7de)",
};

export function RoleListPage({ onNew }: { onNew?: () => void }) {
  const roles = useRoles();
  const del = useDeleteRole();
  const { can } = usePermissions();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<identity.Role | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const canAdmin = can("identity:admin");

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete.id, {
      onSuccess: () => { toast({ kind: "success", title: "ロールを削除しました" }); setPendingDelete(null); },
      onError: (err) => { toast({ kind: "error", title: "削除に失敗しました", description: errorMessage(err) }); setPendingDelete(null); },
    });
  }

  const items = roles.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="ロール管理"
        description="ロールを開くと、その場で権限を確認・編集できます。"
        testId="fe7-roles-header"
        actions={canAdmin ? <Button variant="primary" onClick={onNew} testId="fe7-roles-new">ロールを作成</Button> : null}
      />
      {roles.isLoading ? (
        // Loading MUST show a skeleton, not fall through to EmptyState, so the user
        // can tell "loading" from "no roles" (FRONTEND_GUIDE §5).
        <div style={listStyle} data-testid="fe7-roles-skeleton">
          <SkeletonList rows={4} />
        </div>
      ) : roles.isError ? (
        <ErrorState error={displayError(roles.error)} onRetry={() => roles.refetch()} testId="fe7-roles-error" />
      ) : items.length === 0 ? (
        <EmptyState title="ロールがありません" testId="fe7-roles-empty" />
      ) : (
        <div style={listStyle} data-testid="fe7-roles-list">
          {items.map((r) => {
            const open = expandedId === r.id;
            return (
              <div key={r.id} style={cardStyle} data-testid={`fe7-roles-row-${r.id}`}>
                <div style={headerRowStyle}>
                  <button
                    type="button"
                    style={toggleStyle}
                    aria-expanded={open}
                    aria-controls={`fe7-role-inline-${r.id}`}
                    onClick={() => setExpandedId(open ? null : r.id)}
                    data-testid={`fe7-roles-open-${r.id}`}
                  >
                    <span aria-hidden style={{ color: "var(--dub-color-fg-muted, #57606a)" }}>{open ? "▾" : "▸"}</span>
                    <span style={nameStyle}>{r.name}</span>
                    {r.isSystem ? (
                      <Badge tone="neutral" testId={`fe7-roles-system-${r.id}`}>システム</Badge>
                    ) : (
                      <Badge tone="success">カスタム</Badge>
                    )}
                    <span style={metaStyle}>{r.permissions.length} 権限</span>
                  </button>
                  {canAdmin && !r.isSystem ? (
                    <Button variant="danger" onClick={() => setPendingDelete(r)} testId={`fe7-roles-delete-${r.id}`}>
                      削除
                    </Button>
                  ) : null}
                </div>
                {open ? (
                  <div style={bodyStyle} id={`fe7-role-inline-${r.id}`}>
                    <RolePermissionsEditor role={r} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
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
