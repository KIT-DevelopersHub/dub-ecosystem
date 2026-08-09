import { useState } from "react";
import type { auditLog } from "@dub/types";
import { PageHeader, DataTable, Select, EmptyState, ErrorState, LoadMore, type Column } from "../ui/primitives";
import { useAuditLogs } from "../hooks/useRosterApi";
import { DEFAULT_AUDIT_FILTERS, type AuditFilters } from "../lib/auditQuery";
import { errorMessage } from "../lib/errorDisplay";

const IDENTITY_ACTIONS = [
  { value: "", label: "すべての identity 操作" },
  { value: "identity.role.assigned", label: "ロール付与" },
  { value: "identity.role.revoked", label: "ロール剥奪" },
  { value: "identity.user.provisioned", label: "ユーザー登録" },
];

export function AuditHistoryPage() {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const query = useAuditLogs({ ...filters, ...(cursor ? { cursor } : {}) });

  const columns: Column<auditLog.AuditRecord>[] = [
    { key: "when", header: "日時", render: (r) => r.occurredAt },
    { key: "action", header: "操作", render: (r) => r.action },
    { key: "actor", header: "実行者", render: (r) => r.actorId ?? "system" },
    { key: "target", header: "対象", render: (r) => r.resourceId ?? "-" },
    { key: "result", header: "結果", render: (r) => r.result },
  ];

  return (
    <div>
      <PageHeader title="変更履歴" testId="fe7-history-header" />
      <Select
        label="操作種別"
        value={filters.action ?? ""}
        onChange={(e) => { setCursor(undefined); setFilters((f) => ({ ...f, action: e.target.value || null })); }}
        testId="fe7-history-action-filter"
      >
        {IDENTITY_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
      </Select>

      {query.isError ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} testId="fe7-history-error" />
      ) : query.data && query.data.items.length === 0 ? (
        <EmptyState message="履歴がありません" testId="fe7-history-empty" />
      ) : (
        <>
          <DataTable columns={columns} rows={query.data?.items ?? []} rowKey={(r) => r.id} rowTestId={(r) => `fe7-history-row-${r.id}`} testId="fe7-history-table" />
          <LoadMore hasMore={!!query.data?.nextCursor} onLoadMore={() => setCursor(query.data?.nextCursor ?? undefined)} testId="fe7-history-loadmore" />
        </>
      )}
    </div>
  );
}
