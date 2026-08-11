import { useState } from "react";
import {
  PageHeader,
  DataTable,
  TextField,
  Select,
  Button,
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
import { InviteUserDialog } from "./InviteUserDialog";
import { NewEmailAddressDialog } from "./NewEmailAddressDialog";
import { useUsers, useSyncEmailRouting, isEmailRoutingUnconfigured } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
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

/** Provenance chip: Email Routing rows vs. manually invited members. */
function SourceBadge({ source, testId }: { source: RosterUser["source"]; testId?: string }) {
  return source === "email-routing" ? (
    <Badge tone="info" testId={testId}>Email Routing</Badge>
  ) : (
    <Badge tone="neutral" testId={testId}>手動</Badge>
  );
}

export function UserListPage({ onOpenUser }: { onOpenUser?: (id: string) => void }) {
  const [filters, setFilters] = useState<UserListFilters>(DEFAULT_USER_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const { can } = usePermissions();
  const query = useUsers({ ...filters, ...(cursor ? { cursor } : {}) });
  const sync = useSyncEmailRouting();

  const canInvite = can("identity:admin");
  const canManageRouting = can("mail:admin"); // read the proxy / issue addresses
  const canSync = canInvite && canManageRouting; // relay proxy -> roster upsert
  const notConnected = isEmailRoutingUnconfigured(sync.error);

  const columns: ColumnDef<RosterUser>[] = [
    {
      key: "name",
      header: "名前",
      cell: (u) => (
        <span data-testid={`fe7-users-row-${u.id}`}>
          {onOpenUser ? (
            <button onClick={() => onOpenUser(u.id)} data-testid={`fe7-users-open-${u.id}`}>
              {u.displayName}
            </button>
          ) : (
            u.displayName
          )}
        </span>
      ),
    },
    { key: "email", header: "メール", cell: (u) => u.email },
    { key: "source", header: "種別", cell: (u) => <SourceBadge source={u.source} testId={`fe7-users-source-${u.id}`} /> },
    { key: "status", header: "状態", cell: (u) => <UserStatusBadge status={u.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="ユーザー名簿"
        testId="fe7-users-header"
        actions={
          <div style={actionsStyle}>
            {canSync ? (
              <Button
                variant="primary"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
                testId="fe7-users-sync"
              >
                {sync.isPending ? <Spinner /> : "Email Routing から同期"}
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
        名簿は Cloudflare Email Routing の @developershub.jp アドレスと同期します。「同期」で最新のアドレスを取り込み、各メンバーにロールと表示名を設定できます。
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
      ) : query.data && query.data.items.length === 0 ? (
        <EmptyState title="該当するユーザーがいません" testId="fe7-users-empty" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            rowKey={(u) => u.id}
            testId="fe7-users-table"
          />
          <LoadMore
            hasMore={!!query.data?.nextCursor}
            onLoadMore={() => setCursor(query.data?.nextCursor ?? undefined)}
            testId="fe7-users-loadmore"
          />
        </>
      )}

      <InviteUserDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <NewEmailAddressDialog
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        onCreated={() => sync.mutate()}
      />
    </div>
  );
}
