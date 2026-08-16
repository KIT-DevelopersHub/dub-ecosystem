import { useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, Badge, Button, ConfirmDialog, EmptyState, ErrorState, SegmentedControl, SkeletonList } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import { useRoles, useDeleteRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { RolePermissionsEditor } from "./RolePermissionsEditor";
import { errorMessage, displayError } from "../lib/errorDisplay";
import styles from "./RoleListPage.module.css";

// Single-screen role management. Roles are switched with the shared @dub/ui
// `SegmentedControl` (the sliding-pill selector); only the selected role's
// permission matrix (view + edit + save) is shown below it. This replaces the old
// vertical accordion — no navigation to a second "role editor" screen, and no
// long stack of expandable cards. One role is active at a time so the shared
// matrix testids never collide on the page.
//
// The first role is selected by default (via `effectiveId`) so the screen is
// never empty: the user lands on a populated matrix and reads the strip as "pick
// a role" rather than an inert header. The pill slide + panel enter animation are
// owned by the core component (see SegmentedControl) and RoleListPage.module.css.
const nameStyle: React.CSSProperties = { fontWeight: 600 };
const metaStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #57606a)", fontSize: 13 };
const skeletonStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const panelStyle: React.CSSProperties = {
  marginTop: 16,
  border: "1px solid var(--dub-color-border-default, #d0d7de)",
  borderRadius: 8,
  padding: 16,
};
const panelHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 };

export function RoleListPage({ onNew }: { onNew?: () => void }) {
  const roles = useRoles();
  const del = useDeleteRole();
  const { can } = usePermissions();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<identity.Role | null>(null);
  // Explicit user pick. When null we fall back to the first role (effectiveId
  // below) so the panel is never empty on load and after a delete.
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
  // Default to the first role until the user picks another; if the current pick
  // was deleted, it falls back to the first remaining role.
  const effectiveId = (activeId && items.some((r) => r.id === activeId) ? activeId : items[0]?.id) ?? null;
  const active = items.find((r) => r.id === effectiveId) ?? null;

  // One segment per role. `controls` wires each tab to its permission panel
  // (aria-controls + aria-expanded); the count/badge live in the segment label.
  const roleOptions: SegmentedOption<string>[] = items.map((r) => ({
    value: r.id,
    testId: `fe7-roles-open-${r.id}`,
    controls: `fe7-role-inline-${r.id}`,
    label: (
      <>
        <span style={nameStyle}>{r.name}</span>
        {r.isSystem ? (
          <Badge tone="neutral" testId={`fe7-roles-system-${r.id}`}>システム</Badge>
        ) : (
          <Badge tone="success">カスタム</Badge>
        )}
        <span style={metaStyle}>{r.permissions.length} 権限</span>
      </>
    ),
  }));

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
          <SegmentedControl
            testId="fe7-roles-list"
            aria-label="ロール"
            caption="ロールを選択"
            captionTestId="fe7-roles-caption"
            value={effectiveId}
            onChange={setActiveId}
            options={roleOptions}
          />

          {active ? (
            // key on role id forces a fresh editor per role AND replays the panel
            // enter animation (styles.panel) on every tab switch, so the content
            // swap reads as one smooth motion rather than an instant jump.
            <div
              key={active.id}
              className={styles.panel}
              style={panelStyle}
              id={`fe7-role-inline-${active.id}`}
              data-testid={`fe7-roles-panel-${active.id}`}
            >
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
              {/* RolePermissionsEditor seeds its name/permissions from useState(role...)
                  at mount only; the changing key above also guarantees a fresh editor
                  per role so the previous role's edits never leak into the next tab. */}
              <RolePermissionsEditor role={active} />
            </div>
          ) : null}
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
