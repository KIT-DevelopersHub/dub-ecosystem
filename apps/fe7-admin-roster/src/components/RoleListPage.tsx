import { useLayoutEffect, useRef, useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, Badge, Button, ConfirmDialog, EmptyState, ErrorState, SkeletonList } from "@dub/ui";
import { useRoles, useDeleteRole } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { RolePermissionsEditor } from "./RolePermissionsEditor";
import { errorMessage, displayError } from "../lib/errorDisplay";
import styles from "./RoleListPage.module.css";

// Single-screen role management. Roles are switched with a top segmented control
// (tab strip); only the selected role's permission matrix (view + edit + save) is
// shown below it. This replaces the old vertical accordion — no navigation to a
// second "role editor" screen, and no long stack of expandable cards. One role is
// active at a time so the shared matrix testids never collide on the page.
//
// The first role is selected by default so the screen is never empty: the user
// lands on a populated matrix and immediately reads the strip as "pick a role"
// rather than an inert header. A pill slides under the active tab (see the CSS
// module) so it is always obvious which role is showing.
const stripStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  padding: 4,
  borderRadius: 10,
  background: "var(--dub-color-surface-sunken, #f3f4f6)",
  border: "1px solid var(--dub-color-border-default, #d0d7de)",
};
const captionStyle: React.CSSProperties = {
  marginBottom: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--dub-color-text-secondary, #57606a)",
};
const tabBaseStyle: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 14px",
  borderRadius: 7,
  border: "1px solid transparent",
  background: "transparent",
  font: "inherit",
  cursor: "pointer",
  color: "var(--dub-color-text-secondary, #57606a)",
};
// The active tab only recolors its text — the sliding pill (styles.indicator)
// supplies the surface/border/shadow, so highlight and motion stay in one place.
const tabActiveStyle: React.CSSProperties = {
  color: "var(--dub-color-brand-600, #1d4ed8)",
};
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

type IndicatorBox = { x: number; y: number; w: number; h: number; show: boolean };

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

  // Slide a pill under the active tab: measure the selected button's box within
  // the strip and hand it to styles.indicator (transform/width transition).
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState<IndicatorBox>({ x: 0, y: 0, w: 0, h: 0, show: false });
  useLayoutEffect(() => {
    const btn = effectiveId ? tabRefs.current.get(effectiveId) : null;
    if (!btn) {
      setIndicator((s) => (s.show ? { ...s, show: false } : s));
      return;
    }
    const measure = () =>
      setIndicator({ x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight, show: btn.offsetWidth > 0 });
    measure();
    // Reflow on strip resize (roles wrapping to a new row shifts every box).
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && stripRef.current) ro.observe(stripRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [effectiveId, items.length]);

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
          <div style={captionStyle} data-testid="fe7-roles-caption">
            ロールを選択
          </div>
          <div
            ref={stripRef}
            className={styles.strip}
            style={stripStyle}
            role="tablist"
            aria-label="ロール"
            data-testid="fe7-roles-list"
          >
            {/* Pill that glides under the selected tab. Geometry is dynamic (measured),
                so it stays inline; the look + easing live in styles.indicator. */}
            <div
              aria-hidden="true"
              className={styles.indicator}
              style={{
                transform: `translate(${indicator.x}px, ${indicator.y}px)`,
                width: indicator.w,
                height: indicator.h,
                opacity: indicator.show ? 1 : 0,
              }}
            />
            {items.map((r) => {
              const open = effectiveId === r.id;
              return (
                <div key={r.id} data-testid={`fe7-roles-row-${r.id}`}>
                  <button
                    type="button"
                    role="tab"
                    ref={(el) => {
                      if (el) tabRefs.current.set(r.id, el);
                      else tabRefs.current.delete(r.id);
                    }}
                    className={styles.tab}
                    style={{ ...tabBaseStyle, ...(open ? tabActiveStyle : null) }}
                    aria-selected={open}
                    aria-expanded={open}
                    aria-controls={`fe7-role-inline-${r.id}`}
                    onClick={() => setActiveId(r.id)}
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
