import { useEffect, useMemo, useState } from "react";
import {
  PageHeader,
  DataTable,
  TextField,
  Select,
  Button,
  IconButton,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadMore,
  FormField,
  Spinner,
  type ColumnDef,
  type SelectOption,
  type SortState,
} from "@dub/ui";
import { BulkActionBar } from "./BulkActionBar";
import { UserStatusBadge } from "./UserStatusBadge";
import { UserInlineEditor } from "./UserInlineEditor";
import { InlineRoleEditor } from "./InlineRoleEditor";
import { InviteUserDialog } from "./InviteUserDialog";
import { NewEmailAddressDialog } from "./NewEmailAddressDialog";
import { SyncPreviewDialog } from "./SyncPreviewDialog";
import { MemberLinkDialog } from "./MemberLinkDialog";
import {
  useUsers,
  useRoles,
  useSyncEmailRouting,
  usePreviewEmailRouting,
  isEmailRoutingUnconfigured,
  useMembersOverview,
  useUnlinkMemberIdentity,
} from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useRosterContext } from "../providers/RosterProvider";
import { DEFAULT_USER_FILTERS, type UserListFilters, type UserStatusFilter } from "../lib/listUsersQuery";
import { displayError } from "../lib/errorDisplay";
import { sortUsers } from "../lib/sortUsers";
import { readRosterViewFromUrl, writeRosterViewToUrl } from "../lib/urlFilters";
import type { RosterUser } from "../contracts/pending";

const STATUS_OPTIONS: SelectOption<UserStatusFilter>[] = [
  { value: "all", label: "すべて" },
  { value: "active", label: "在籍" },
  { value: "invited", label: "招待中" },
  { value: "disabled", label: "停止" },
  { value: "rejected", label: "却下" },
];

const toolbarStyle: React.CSSProperties = { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" };
const actionsStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center" };
const noticeBodyStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const noticeTitleStyle: React.CSSProperties = { fontWeight: 600 };
const noticeTextStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 13, margin: 0 };
const summaryStyle: React.CSSProperties = { color: "var(--dub-color-fg-muted, #57606a)", fontSize: 13, margin: "12px 0 8px", fontWeight: 500 };

// Master (table) + detail (right pane) — the roster and the selected user's management
// surface sit side by side on ONE screen. Wraps under the table on narrow viewports.
const splitStyle: React.CSSProperties = { display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginTop: 16 };
const tableColStyle: React.CSSProperties = { flex: "1 1 460px", minWidth: 0 };
const paneColStyle: React.CSSProperties = { flex: "1 1 340px", minWidth: 300, position: "sticky", top: 16 };
const paneHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 };
const paneTitleStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 16, minWidth: 0 };

function nameButtonStyle(selected: boolean): React.CSSProperties {
  return {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    cursor: "pointer",
    textAlign: "left",
    color: "var(--dub-color-accent-fg, #0969da)",
    fontWeight: selected ? 700 : 500,
    textDecoration: selected ? "underline" : "none",
  };
}

/** Provenance chip: Email Routing rows vs. manually invited members. */
function SourceBadge({ source, testId }: { source: RosterUser["source"]; testId?: string }) {
  return source === "email-routing" ? (
    <Badge tone="info" testId={testId}>Email Routing</Badge>
  ) : (
    <Badge tone="neutral" testId={testId}>手動</Badge>
  );
}

export function UserListPage() {
  // ⑧ Seed filters + sort from the URL so a shared/bookmarked view restores on load.
  const initialView = useMemo(() => readRosterViewFromUrl(), []);
  const [filters, setFilters] = useState<UserListFilters>({ ...DEFAULT_USER_FILTERS, ...initialView.filters });
  const [sort, setSort] = useState<SortState | undefined>(initialView.sort);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkAccount, setLinkAccount] = useState<RosterUser | null>(null);
  const { can } = usePermissions();
  const { me } = useRosterContext();
  const query = useUsers({ ...filters, ...(cursor ? { cursor } : {}) });
  // ⑤ Unfiltered total for the「X件中Y件」summary (cheap: cached, one page in demo).
  const totalQuery = useUsers(DEFAULT_USER_FILTERS);

  // ⑧ Mirror the active filter + sort into the URL query (replace, not push).
  useEffect(() => {
    writeRosterViewToUrl({ filters: { search: filters.search, status: filters.status }, sort });
  }, [filters.search, filters.status, sort]);
  const rolesQuery = useRoles();
  const sync = useSyncEmailRouting();
  const preview = usePreviewEmailRouting();
  const membersOverview = useMembersOverview();
  const unlinkMember = useUnlinkMemberIdentity();
  const [previewOpen, setPreviewOpen] = useState(false);

  const currentUserId = me?.user.id ?? "";
  const canInvite = can("identity:admin");
  const canManageRoles = can("identity:admin"); // grant/revoke org-wide roles inline
  const canLinkMembers = can("identity:admin"); // link/unlink 運営メンバー from the メール名簿 side
  const roles = rolesQuery.data?.items ?? [];
  // identity userId -> the 運営メンバー linked to it (1:1). Drives the「運営メンバー」列.
  const memberByIdentity = new Map(
    (membersOverview.data?.members ?? [])
      .filter((m) => !!m.identityUserId)
      .map((m) => [m.identityUserId as string, m]),
  );
  const canManageRouting = can("mail:admin"); // read the proxy / issue addresses
  const canSync = canInvite && canManageRouting; // relay proxy -> roster upsert
  const notConnected = isEmailRoutingUnconfigured(sync.error) || isEmailRoutingUnconfigured(preview.error);

  // #5: preview first (read-only diff), then apply from the dialog with an explicit button.
  function openPreview() {
    preview.mutate(undefined, { onSuccess: () => setPreviewOpen(true) });
  }
  function applySync() {
    sync.mutate(undefined, {
      onSuccess: () => {
        setPreviewOpen(false);
        preview.reset();
      },
    });
  }

  const items = query.data?.items ?? [];
  // ⑤ Client-side sort of the loaded rows (demo returns the full set in one page).
  const sortedItems = useMemo(() => sortUsers(items, sort), [items, sort]);
  // ⑤ Count summary: total (unfiltered) vs. currently shown (filtered) rows.
  const shownCount = items.length;
  const totalCount = totalQuery.data?.items.length ?? shownCount;
  const isNarrowed = filters.search.trim() !== "" || filters.status !== "all";
  const countSummary = isNarrowed ? `${totalCount}件中 ${shownCount}件を表示` : `全 ${totalCount}件`;
  // Selection acts on the currently-loaded rows; drop keys that left the filter.
  const visibleIds = new Set(items.map((u) => u.id));
  const effectiveSelected = selectedIds.filter((id) => visibleIds.has(id));
  const canBulk = can("identity:admin");
  // Resolve the selection against the freshest list so the pane reflects saved edits
  // and closes itself if the selected user drops out of the current filter.
  const selectedUser = items.find((u) => u.id === selectedId) ?? null;

  const columns: ColumnDef<RosterUser>[] = [
    {
      key: "name",
      header: "名前",
      sortable: true,
      cell: (u) => (
        <span data-testid={`fe7-users-row-${u.id}`}>
          <button
            type="button"
            onClick={() => setSelectedId(u.id)}
            aria-current={selectedId === u.id ? "true" : undefined}
            data-testid={`fe7-users-open-${u.id}`}
            style={nameButtonStyle(selectedId === u.id)}
          >
            {u.displayName}
          </button>
        </span>
      ),
    },
    { key: "email", header: "メール", sortable: true, cell: (u) => u.email },
    { key: "source", header: "種別", sortable: true, cell: (u) => <SourceBadge source={u.source} testId={`fe7-users-source-${u.id}`} /> },
    {
      key: "member",
      header: "運営メンバー",
      // noWrap keeps the badge名/ボタンを1行に保つ (white-space:nowrap)。列見出しが文脈を
      // 与えるのでボタンは「紐付け」に短縮し、幅を詰め込みすぎず1行に収める。
      noWrap: true,
      minWidth: "9rem",
      cell: (u) => {
        const linked = memberByIdentity.get(u.id);
        if (linked) {
          return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} data-testid={`fe7-users-member-${u.id}`}>
              <Badge tone="success">{linked.name}</Badge>
              {canLinkMembers ? (
                <IconButton
                  name="x"
                  aria-label={`${u.email} と ${linked.name} の紐付けを解除`}
                  onClick={() => unlinkMember.mutate({ member: linked })}
                  testId={`fe7-users-member-unlink-${u.id}`}
                />
              ) : null}
            </span>
          );
        }
        return canLinkMembers ? (
          <Button variant="ghost" size="sm" onClick={() => setLinkAccount(u)} testId={`fe7-users-member-link-${u.id}`}>
            紐付け
          </Button>
        ) : (
          <span style={{ color: "var(--dub-color-fg-muted, #57606a)" }}>未設定</span>
        );
      },
    },
    {
      key: "roles",
      header: "ロール",
      cell: (u) => <InlineRoleEditor user={u} roles={roles} currentUserId={currentUserId} canAdmin={canManageRoles} />,
    },
    { key: "status", header: "状態", sortable: true, cell: (u) => <UserStatusBadge status={u.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="メール名簿"
        testId="fe7-users-header"
        actions={
          <div style={actionsStyle}>
            {canSync ? (
              <Button
                variant="primary"
                onClick={openPreview}
                disabled={preview.isPending || sync.isPending}
                testId="fe7-users-sync"
              >
                {preview.isPending ? <Spinner /> : "Email Routing から同期"}
              </Button>
            ) : null}
            {canManageRouting ? (
              <Button variant="secondary" onClick={() => setIssueOpen(true)} testId="fe7-users-issue">
                アドレスを発行
              </Button>
            ) : null}
            {canInvite ? (
              <Button variant="secondary" onClick={() => setInviteOpen(true)} testId="fe7-users-invite">
                ユーザーを招待
              </Button>
            ) : null}
          </div>
        }
      />

      <p style={noticeTextStyle}>
        名簿は Cloudflare Email Routing の @developershub.jp アドレスと同期します。「運営メンバー」列から各アドレスを運営メンバーと紐付け・解除できます。ロール列をクリックすると、各メンバーのロールをその場で追加・削除できます。表示名や在籍状態の変更は、名前をクリックすると右側でその場で編集できます。
      </p>

      {notConnected ? (
        <Card testId="fe7-routing-unconfigured">
          <div style={noticeBodyStyle}>
            <span style={noticeTitleStyle}>Email Routing に未接続です</span>
            <p style={noticeTextStyle}>
              Cloudflare Email Routing のトークンが未設定のため同期できません。接続後にもう一度お試しください。
            </p>
          </div>
        </Card>
      ) : null}

      <div style={toolbarStyle}>
        <FormField label="検索" htmlFor="fe7-users-search">
          <TextField
            id="fe7-users-search"
            value={filters.search}
            onChange={(v) => {
              setCursor(undefined);
              setSelectedIds([]);
              setFilters((f) => ({ ...f, search: v }));
            }}
            testId="fe7-users-search"
          />
        </FormField>
        <FormField label="状態" htmlFor="fe7-users-status-filter">
          <Select
            id="fe7-users-status-filter"
            value={filters.status}
            options={STATUS_OPTIONS}
            onChange={(v) => {
              setCursor(undefined);
              setSelectedIds([]);
              setFilters((f) => ({ ...f, status: v }));
            }}
            testId="fe7-users-status-filter"
          />
        </FormField>
      </div>

      {query.isError ? (
        <ErrorState error={displayError(query.error)} onRetry={() => query.refetch()} testId="fe7-users-error" />
      ) : query.data && items.length === 0 ? (
        <EmptyState title="該当するユーザーがいません" testId="fe7-users-empty" />
      ) : (
        <div style={splitStyle}>
          <div style={tableColStyle}>
            <p style={summaryStyle} data-testid="fe7-users-count">
              {countSummary}
              {effectiveSelected.length > 0 ? `・${effectiveSelected.length}件を選択中` : ""}
            </p>
            {canBulk && effectiveSelected.length > 0 ? (
              <BulkActionBar
                selectedIds={effectiveSelected}
                roles={roles}
                canSetStatus={canBulk}
                canAssignRole={canManageRoles}
                onClear={() => setSelectedIds([])}
                testId="fe7-users-bulk"
              />
            ) : null}
            <DataTable
              columns={columns}
              rows={sortedItems}
              rowKey={(u) => u.id}
              sort={sort}
              onSortChange={setSort}
              selection={canBulk ? { selectedKeys: selectedIds, onChange: setSelectedIds } : undefined}
              onRowClick={(u) => setSelectedId(u.id)}
              testId="fe7-users-table"
            />
            <LoadMore
              hasMore={!!query.data?.nextCursor}
              onLoadMore={() => setCursor(query.data?.nextCursor ?? undefined)}
              testId="fe7-users-loadmore"
            />
          </div>

          {selectedUser ? (
            <div style={paneColStyle}>
              <Card testId="fe7-user-pane">
                <div style={paneHeaderStyle}>
                  <span style={paneTitleStyle}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedUser.displayName}
                    </span>
                    <UserStatusBadge status={selectedUser.status} testId="fe7-user-status" />
                  </span>
                  <IconButton
                    name="x"
                    aria-label="閉じる"
                    onClick={() => setSelectedId(null)}
                    testId="fe7-user-pane-close"
                  />
                </div>
                <UserInlineEditor
                  key={selectedUser.id}
                  user={selectedUser}
                  currentUserId={currentUserId}
                  events={[]}
                />
              </Card>
            </div>
          ) : (
            <div style={paneColStyle}>
              <Card testId="fe7-user-pane-empty">
                <EmptyState title="ユーザーを選択してください" description="一覧から名前をクリックすると、ここで編集できます。" />
              </Card>
            </div>
          )}
        </div>
      )}

      <InviteUserDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <NewEmailAddressDialog
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        onCreated={openPreview}
      />
      <SyncPreviewDialog
        open={previewOpen}
        preview={preview.data ?? null}
        applying={sync.isPending}
        onApply={applySync}
        onCancel={() => setPreviewOpen(false)}
      />
      <MemberLinkDialog open={!!linkAccount} account={linkAccount} onClose={() => setLinkAccount(null)} />
    </div>
  );
}
