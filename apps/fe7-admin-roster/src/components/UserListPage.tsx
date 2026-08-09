import { useState } from "react";
import type { identity } from "@dub/types";
import { PageHeader, DataTable, TextField, Select, Button, EmptyState, ErrorState, LoadMore, type Column } from "../ui/primitives";
import { UserStatusBadge } from "./UserStatusBadge";
import { InviteUserDialog } from "./InviteUserDialog";
import { useUsers } from "../hooks/useRosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { DEFAULT_USER_FILTERS, type UserListFilters, type UserStatusFilter } from "../lib/listUsersQuery";
import { errorMessage } from "../lib/errorDisplay";

const STATUS_OPTIONS: { value: UserStatusFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "active", label: "在籍" },
  { value: "invited", label: "招待中" },
  { value: "disabled", label: "停止" },
  { value: "rejected", label: "却下" },
];

export function UserListPage({ onOpenUser }: { onOpenUser?: (id: string) => void }) {
  const [filters, setFilters] = useState<UserListFilters>(DEFAULT_USER_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [inviteOpen, setInviteOpen] = useState(false);
  const { can } = usePermissions();
  const query = useUsers({ ...filters, ...(cursor ? { cursor } : {}) });

  const canInvite = can("identity:admin");

  const columns: Column<identity.IdentityUser>[] = [
    {
      key: "name",
      header: "名前",
      render: (u) =>
        onOpenUser ? (
          <button onClick={() => onOpenUser(u.id)} data-testid={`fe7-users-open-${u.id}`}>{u.displayName}</button>
        ) : (
          u.displayName
        ),
    },
    { key: "email", header: "メール", render: (u) => u.email },
    { key: "status", header: "状態", render: (u) => <UserStatusBadge status={u.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="ユーザー名簿"
        testId="fe7-users-header"
        actions={
          canInvite ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)} testId="fe7-users-invite">
              ユーザーを招待
            </Button>
          ) : null
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <TextField
          label="検索"
          value={filters.search}
          onChange={(e) => { setCursor(undefined); setFilters((f) => ({ ...f, search: e.target.value })); }}
          testId="fe7-users-search"
        />
        <Select
          label="状態"
          value={filters.status}
          onChange={(e) => { setCursor(undefined); setFilters((f) => ({ ...f, status: e.target.value as UserStatusFilter })); }}
          testId="fe7-users-status-filter"
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </div>

      {query.isError ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} testId="fe7-users-error" />
      ) : query.data && query.data.items.length === 0 ? (
        <EmptyState message="該当するユーザーがいません" testId="fe7-users-empty" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            rowKey={(u) => u.id}
            rowTestId={(u) => `fe7-users-row-${u.id}`}
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
    </div>
  );
}
