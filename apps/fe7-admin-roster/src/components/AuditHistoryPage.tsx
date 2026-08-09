import { useState } from "react";
import type { auditLog } from "@dub/types";
import {
  PageHeader,
  DataTable,
  Select,
  EmptyState,
  ErrorState,
  LoadMore,
  FormField,
  type ColumnDef,
  type SelectOption,
} from "@dub/ui";
import { useAuditLogs } from "../hooks/useRosterApi";
import { DEFAULT_AUDIT_FILTERS, type AuditFilters } from "../lib/auditQuery";
import { displayError } from "../lib/errorDisplay";

const IDENTITY_ACTIONS: SelectOption[] = [
  { value: "", label: "すべての identity 操作" },
  { value: "identity.role.assigned", label: "ロール付与" },
  { value: "identity.role.revoked", label: "ロール剥奪" },
  { value: "identity.user.provisioned", label: "ユーザー登録" },
];

export function AuditHistoryPage() {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const query = useAuditLogs({ ...filters, ...(cursor ? { cursor } : {}) });

  // Row identity testid surfaced on the first cell (@dub/ui DataTable has no rowTestId).
  const columns: ColumnDef<auditLog.AuditRecord>[] = [
    { key: "when", header: "日時", cell: (r) => <span data-testid={`fe7-history-row-${r.id}`}>{r.occurredAt}</span> },
    { key: "action", header: "操作", cell: (r) => r.action },
    { key: "actor", header: "実行者", cell: (r) => r.actorId ?? "system" },
    { key: "target", header: "対象", cell: (r) => r.resourceId ?? "-" },
    { key: "result", header: "結果", cell: (r) => r.result },
  ];

  return (
    <div>
      <PageHeader title="変更履歴" testId="fe7-history-header" />
      <FormField label="操作種別" htmlFor="fe7-history-action-filter">
        <Select
          id="fe7-history-action-filter"
          value={filters.action ?? ""}
          options={IDENTITY_ACTIONS}
          onChange={(v) => {
            setCursor(undefined);
            setFilters((f) => ({ ...f, action: v || null }));
          }}
          testId="fe7-history-action-filter"
        />
      </FormField>

      {query.isError ? (
        <ErrorState error={displayError(query.error)} onRetry={() => query.refetch()} testId="fe7-history-error" />
      ) : query.data && query.data.items.length === 0 ? (
        <EmptyState title="履歴がありません" testId="fe7-history-empty" />
      ) : (
        <>
          <DataTable columns={columns} rows={query.data?.items ?? []} rowKey={(r) => r.id} testId="fe7-history-table" />
          <LoadMore hasMore={!!query.data?.nextCursor} onLoadMore={() => setCursor(query.data?.nextCursor ?? undefined)} testId="fe7-history-loadmore" />
        </>
      )}
    </div>
  );
}
