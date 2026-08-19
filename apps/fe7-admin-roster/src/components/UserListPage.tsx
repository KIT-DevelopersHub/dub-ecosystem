import { useState } from "react";
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
} from "@dub/ui";
import { UserStatusBadge } from "./UserStatusBadge";
import { UserInlineEditor } from "./UserInlineEditor";
import { InlineRoleEditor } from "./InlineRoleEditor";
import { InviteUserDialog } from "./InviteUserDialog";
import { NewEmailAddressDialog } from "./NewEmailAddressDialog";
import { SyncPreviewDialog } from "./SyncPreviewDialog";
import { useUsers, useRoles, useSyncEmailRouting, usePreviewEmailRouting, isEmailRoutingUnconfigured } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { useRosterContext } from "../providers/RosterProvider";
import { DEFAULT_USER_FILTERS, type UserListFilters, type UserStatusFilter } from "../lib/listUsersQuery";
import { displayError } from "../lib/errorDisplay";
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
  const [filters, setFilters] = useState<UserListFilters>(DEFAULT_USER_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { can } = usePermissions();
  const { me } = useRosterContext();
  const query = useUsers({ ...filters, ...(cursor ? { cursor } : {}) });
  const rolesQuery = useRoles();
  const sync = useSyncEmailRouting();
  const preview = usePreviewEmailRouting();
  const [previewOpen, setPreviewOpen] = useState(false);

  const currentUserId = me?.user.id ?? "";
  const canInvite = can("identity:admin");
  const canManageRoles = can("identity:admin"); // grant/revoke org-wide roles inline
  const roles = rolesQuery.data?.items ?? [];
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
  // Resolve the selection against the freshest list so the pane reflects saved edits
  // and closes itself if the selected user drops out of the current filter.
  const selectedUser = items.find((u) => u.id === selectedId) ?? null;

  const columns: ColumnDef<RosterUser>[] = [
    {
      key: "name",
      header: "名前",
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
    { key: "email", header: "メール", cell: (u) => u.email },
    { key: "source", header: "種別", cell: (u) => <SourceBadge source={u.source} testId={`fe7-users-source-${u.id}`} /> },
    {
      key: "roles",
      header: "ロール",
      cell: (u) => <InlineRoleEditor user={u} roles={roles} currentUserId={currentUserId} canAdmin={canManageRoles} />,
    },
    { key: "status", header: "状態", cell: (u) => <UserStatusBadge status={u.status} /> },
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
        名簿は Cloudflare Email Routing の @developershub.jp アドレスと同期します。ロール列をクリックすると、各メンバーのロールをその場で追加・削除できます。表示名や在籍状態の変更は、名前をクリックすると右側でその場で編集できます。
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
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(u) => u.id}
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
    </div>
  );
}
