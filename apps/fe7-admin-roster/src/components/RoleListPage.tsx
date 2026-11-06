import { useMemo, useState } from "react";
import { PageHeader, Badge, Button, ConfirmDialog, EmptyState, ErrorState, Icon, SegmentedControl, SkeletonList, TextField } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import { useRoles, useDeleteRole } from "../hooks/useRosterApi";
import { useCanAdminEdit } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { RolePermissionsEditor } from "./RolePermissionsEditor";
import type { RoleView } from "../contracts/pending";
import { errorMessage, displayError } from "../lib/errorDisplay";
import { groupRoles, matchesRoleQuery, roleDeleteMessage, roleDisplayName, ROLE_GROUPS } from "../lib/roleGroups";
import type { RoleGroupId } from "../lib/roleGroups";
import styles from "./RoleListPage.module.css";

// Single-screen role management. Roles are switched with the shared @dub/ui
// `SegmentedControl` (the sliding-pill selector); only the selected role's
// policy editor (アプリ別 3 段階の表 + 詳細ダイアログ + その他 + save) is shown below it. This replaces the old
// vertical accordion — no navigation to a second "role editor" screen, and no
// long stack of expandable cards. One role is active at a time so the shared
// matrix testids never collide on the page.
//
// The first role is selected by default (via `effectiveId`) so the screen is
// never empty: the user lands on a populated matrix and reads the strip as "pick
// a role" rather than an inert header. The pill slide + panel enter animation are
// owned by the core component (see SegmentedControl) and RoleListPage.module.css.
//
// Roles are grouped by genre (システム / 運営ロール / チーム / 役職 / その他, see
// lib/roleGroups) into collapsible sections, each with its own SegmentedControl;
// the selection is still a single role across all sections. Open/closed state is
// remembered per viewer in localStorage; a name filter spans every group.
const OPEN_KEY = "fe7.roles.groupOpen";

function readOpenState(): Partial<Record<RoleGroupId, boolean>> {
  try {
    const raw = globalThis.localStorage?.getItem(OPEN_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<RoleGroupId, boolean>>) : {};
  } catch {
    return {};
  }
}

function writeOpenState(state: Partial<Record<RoleGroupId, boolean>>) {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode etc.) — state just isn't remembered */
  }
}

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
  const canAdminEdit = useCanAdminEdit();
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<RoleView | null>(null);
  // Explicit user pick. When null we fall back to the first role (effectiveId
  // below) so the panel is never empty on load and after a delete.
  // Deep link: ?role=<id>&app=<appId> opens that role with the app's 詳細設定 dialog, so a
  // setting at the bottom of a dialog (e.g. メール > 別のロール宛て) can be linked directly.
  const [deepLink] = useState(() => {
    const p = new URLSearchParams(globalThis.location?.search ?? "");
    return { role: p.get("role"), app: p.get("app") };
  });
  const [activeId, setActiveId] = useState<string | null>(() => deepLink.role);
  const canAdmin = canAdminEdit;
  const [query, setQuery] = useState("");
  const [openState, setOpenState] = useState(readOpenState);

  function confirmDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete.id, {
      onSuccess: () => { toast({ kind: "success", title: "ロールを削除しました" }); setPendingDelete(null); setActiveId(null); },
      onError: (err) => { toast({ kind: "error", title: "削除に失敗しました", description: errorMessage(err) }); setPendingDelete(null); },
    });
  }

  const items = roles.data?.items ?? [];
  // Default to the first role until the user picks another; if the current pick
  // was deleted, it falls back to the first remaining role (see effectiveId below).

  const groups = useMemo(() => groupRoles(items), [items]);
  // The default is the first role of the first section (not raw API order, which may
  // start with a collapsed auto group).
  const effectiveId = (activeId && items.some((r) => r.id === activeId) ? activeId : groups[0]?.roles[0]?.id) ?? null;
  const active = items.find((r) => r.id === effectiveId) ?? null;
  const filtering = query.trim() !== "";
  const visibleGroups = groups
    .map((g) => ({ ...g, roles: g.roles.filter((r) => matchesRoleQuery(r, query)) }))
    .filter((g) => g.roles.length > 0);
  // A deep-linked role opens its section on first render even if it defaults closed.
  const deepLinkGroup = deepLink.role ? groups.find((g) => g.roles.some((r) => r.id === deepLink.role))?.id : undefined;
  const isOpen = (id: RoleGroupId) =>
    filtering || (openState[id] ?? (id === deepLinkGroup || ROLE_GROUPS.find((g) => g.id === id)!.defaultOpen));
  function toggleGroup(id: RoleGroupId) {
    const next = { ...openState, [id]: !isOpen(id) };
    setOpenState(next);
    writeOpenState(next);
  }

  // One segment per role. `controls` wires each tab to its permission panel
  // (aria-controls + aria-expanded); the count/badge live in the segment label.
  const toOption = (r: RoleView, group: RoleGroupId): SegmentedOption<string> => {
    const label = roleDisplayName(r, group);
    return {
      value: r.id,
      testId: `fe7-roles-open-${r.id}`,
      controls: `fe7-role-inline-${r.id}`,
      label: (
        <>
          <span style={nameStyle} title={label !== r.name ? r.name : undefined}>{label}</span>
          {group === "system" || group === "ops" ? (
            r.isSystem ? (
              <Badge tone="neutral" testId={`fe7-roles-system-${r.id}`}>システム</Badge>
            ) : (
              <Badge tone="success">カスタム</Badge>
            )
          ) : null}
          <span style={metaStyle}>{r.permissions.length} 権限</span>
        </>
      ),
    };
  };

  return (
    <div>
      <PageHeader
        title="ロール管理"
        description={`上のタブでロールを切り替え、アプリごとに「無効 / 閲覧 / 編集」を選びます。${canAdmin ? "ロールの削除は、選択したロールのパネル右上から行えます。" : ""}`}
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
          <div className={styles.toolbar}>
            <span className={styles.caption} data-testid="fe7-roles-caption">ロールを選択</span>
            <label htmlFor="fe7-roles-filter" className={styles.srOnly}>ロールを絞り込み</label>
            <div className={styles.filter}>
              <TextField
                id="fe7-roles-filter"
                value={query}
                onChange={setQuery}
                placeholder="ロール名で絞り込み"
                size="sm"
                testId="fe7-roles-filter"
              />
            </div>
          </div>
          <div className={styles.groups} data-testid="fe7-roles-list">
            {visibleGroups.length === 0 ? (
              <p className={styles.noMatch} data-testid="fe7-roles-no-match">「{query.trim()}」に一致するロールはありません</p>
            ) : null}
            {visibleGroups.map((g) => {
              const open = isOpen(g.id);
              const bodyId = `fe7-roles-group-body-${g.id}`;
              const total = groups.find((x) => x.id === g.id)?.roles.length ?? g.roles.length;
              return (
                <section key={g.id} className={styles.group} data-testid={`fe7-roles-group-${g.id}`} data-open={open}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    aria-expanded={open}
                    aria-controls={bodyId}
                    disabled={filtering}
                    onClick={() => toggleGroup(g.id)}
                    data-testid={`fe7-roles-group-toggle-${g.id}`}
                  >
                    <Icon name={open ? "chevron-down" : "chevron-right"} size="sm" />
                    <span className={styles.groupTitle}>{g.label}</span>
                    <span className={styles.groupCount} data-testid={`fe7-roles-group-count-${g.id}`}>
                      {filtering ? `${g.roles.length} / ${total}` : total}
                    </span>
                  </button>
                  {open ? (
                    <div id={bodyId} className={styles.groupBody}>
                      <SegmentedControl
                        testId={`fe7-roles-group-list-${g.id}`}
                        aria-label={`ロール: ${g.label}`}
                        value={g.roles.some((r) => r.id === effectiveId) ? effectiveId : null}
                        onChange={setActiveId}
                        options={g.roles.map((r) => toOption(r, g.id))}
                      />
                    </div>
                  ) : null}
                </section>
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
                {!canAdmin ? null : active.isSystem ? (
                  <span style={metaStyle} data-testid="fe7-roles-delete-unavailable">削除できるのはシステム以外のロールです</span>
                ) : (
                  <Button variant="danger" onClick={() => setPendingDelete(active)} testId={`fe7-roles-delete-${active.id}`}>
                    削除
                  </Button>
                )}
              </div>
              {/* RolePermissionsEditor seeds its name/permissions from useState(role...)
                  at mount only; the changing key above also guarantees a fresh editor
                  per role so the previous role's edits never leak into the next tab. */}
              <RolePermissionsEditor role={active} initialDetailAppId={active.id === deepLink.role ? deepLink.app : null} />
            </div>
          ) : null}
        </>
      )}
      <ConfirmDialog
        title="ロールを削除"
        message={pendingDelete ? roleDeleteMessage(pendingDelete) : ""}
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
