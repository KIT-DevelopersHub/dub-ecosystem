import { useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, Badge, Button, ConfirmDialog, EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import { useRoles, useDeleteRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { RolePermissionsEditor } from "./RolePermissionsEditor";
import { errorMessage, displayError } from "../lib/errorDisplay";

// Single-screen role management. Roles are switched with a top segmented control
// (tab strip); only the selected role's permission matrix (view + edit + save) is
// shown below it. This replaces the old vertical accordion — no navigation to a
// second "role editor" screen, and no long stack of expandable cards. One role is
// active at a time so the shared matrix testids never collide on the page.
const stripStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  padding: 4,
  borderRadius: 10,
  background: "var(--dub-color-surface-muted, #f3f4f6)",
  border: "1px solid var(--dub-color-border-default, #d0d7de)",
};
const tabBaseStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 14px",
  borderRadius: 7,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "transparent",
  background: "transparent",
  font: "inherit",
  cursor: "pointer",
  color: "var(--dub-color-text-secondary, #57606a)",
};
const tabActiveStyle: React.CSSProperties = {
  background: "var(--dub-color-surface-base, #ffffff)",
  borderColor: "var(--dub-color-brand-500, #2563eb)",
  color: "var(--dub-color-brand-600, #1d4ed8)",
  boxShadow: "0 1px 2px rgba(16, 24, 40, 0.06)",
};
const nameStyle: React.CSSProperties = { fontWeight: 600 };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 13 };
const skeletonStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const panelStyle: React.CSSProperties = {
  marginTop: 16,
  border: "1px solid var(--dub-color-border-default, #d0d7de)",
  borderRadius: 8,
  padding: 16,
};
const panelHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", marginTop: 16 };

export function RoleListPage({ onNew }: { onNew?: () => void }) {
  const roles = useRoles();
  const del = useDeleteRole();
  const { can } = usePermissions();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<identity.Role | null>(null);
  // null = no role selected yet (nothing shown below the tab strip).
  const [activeId, setActiveId] = useState<string | null>(null);
  const canAdmin = can("identity:admin");

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete.id, {
      onSuccess: () => { toast({ kind: "success", title: "ロールを削除しました" }); setPendingDelete(null); setActiveId(null); },
      onError: (err) => { toast({ kind: "error", title: "削除に失敗しました", description: errorMessage(err) }); setPendingDelete(null); },
    });
  }

  const items = roles.data?.items ?? [];
  const active = items.find((r) => r.id === activeId) ?? null;

  return (
    <div>
      <PageHeader
        title="ロール管理"
        description="上のタブでロールを切り替えると、その権限をその場で確認・編集できます。"
        testId="fe7-roles-header"
        actions={canAdmin ? <Button variant="primary" onClick={onNew} testId="fe7-roles-new">ロールを作成</Button> : null}
      />
      {roles.isLoading ? (
        // Loading MUST show a skeleton, not fall through to EmptyState, so the user
        // can tell "loading" from "no roles" (FRONTEND_GUIDE §5).
        <div style={skeletonStyle} data-testid="fe7-roles-skeleton">
          <SkeletonList rows={4} />
        </div>
      ) : roles.isError ? (
        <ErrorState error={displayError(roles.error)} onRetry={() => roles.refetch()} testId="fe7-roles-error" />
      ) : items.length === 0 ? (
        <EmptyState title="ロールがありません" testId="fe7-roles-empty" />
      ) : (
        <>
          <div style={stripStyle} role="tablist" aria-label="ロール" data-testid="fe7-roles-list">
            {items.map((r) => {
              const open = activeId === r.id;
              return (
                <div key={r.id} data-testid={`fe7-roles-row-${r.id}`}>
                  <button
                    type="button"
                    role="tab"
                    style={{ ...tabBaseStyle, ...(open ? tabActiveStyle : null) }}
                    aria-selected={open}
                    aria-expanded={open}
                    aria-controls={`fe7-role-inline-${r.id}`}
                    onClick={() => setActiveId(open ? null : r.id)}
                    data-testid={`fe7-roles-open-${r.id}`}
                  >
                    <span style={nameStyle}>{r.name}</span>
                    {r.isSystem ? (
                      <Badge tone="neutral" testId={`fe7-roles-system-${r.id}`}>システム</Badge>
                    ) : (
                      <Badge tone="success">カスタム</Badge>
                    )}
                    <span style={metaStyle}>{r.permissions.length} 権限</span>
                  </button>
                </div>
              );
            })}
          </div>

          {active ? (
            <div style={panelStyle} id={`fe7-role-inline-${active.id}`} data-testid={`fe7-roles-panel-${active.id}`}>
              <div style={panelHeaderStyle}>
                <span style={nameStyle}>{active.name}</span>
                {active.isSystem ? <Badge tone="neutral">システム</Badge> : <Badge tone="success">カスタム</Badge>}
                <span style={{ flex: 1 }} />
                {canAdmin && !active.isSystem ? (
                  <Button variant="danger" onClick={() => setPendingDelete(active)} testId={`fe7-roles-delete-${active.id}`}>
                    削除
                  </Button>
                ) : null}
              </div>
              {/* key on role id forces a fresh editor per role: RolePermissionsEditor
                  seeds its name/permissions from useState(role...) at mount only, so
                  without a changing key React would reuse the instance and leak the
                  previously-selected role's edits into the next tab. */}
              <RolePermissionsEditor key={active.id} role={active} />
            </div>
          ) : (
            <p style={hintStyle} data-testid="fe7-roles-hint">上のタブからロールを選んでください。</p>
          )}
        </>
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
