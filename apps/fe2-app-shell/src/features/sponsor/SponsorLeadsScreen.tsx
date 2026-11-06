// スポンサー → 営業。声をかけた企業の進捗の表 (旧 スプレッドシート)。
// 上に集計 (登録企業数・接触済・提案済・内諾/契約)、ステータスと営業担当で絞り込み、企業名/担当者/次回アクション/メモで検索。
// ステータスは表の中で直接変えられる。行を押すと全項目の詳細ドロワー。
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChips,
  Select,
  SkeletonTable,
  TextField,
  type ColumnDef,
  type SortState,
} from "@dub/ui";
import { useClientFilter } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { isTempLead, useLeads, useUpdateLead } from "./leadHooks.ts";
import { formatAmount, formatOn, isOverdue, sortLeads, STATUS_TONE, summarizeLeads, todayIso } from "./leads.ts";
import { LeadCreateDrawer, LeadDrawer } from "./LeadDrawer.tsx";
import { LeadImportDialog } from "./LeadImportDialog.tsx";
import { memberOptions, UNKNOWN_MEMBER, useSponsorCapability } from "./SponsorShared.tsx";
import { SponsorFrame } from "./SponsorCardsScreen.tsx";
import styles from "./sponsor.module.css";

type Lead = sponsor.SponsorLead;

const ownerOf = (l: Lead): string => l.owner ?? UNKNOWN_MEMBER;

const searchText = (l: Lead): string =>
  [l.companyName, l.industry, l.owner, l.contactName, l.source, l.nextAction, l.note].filter(Boolean).join(" ");

/** ステータスのセル。編集できる人は表の中で変えられる (同じ行の連続変更は保存が終わるまで止める)。 */
function StatusCell({ lead }: { lead: Lead }): JSX.Element {
  const { canWrite } = useSponsorCapability();
  const update = useUpdateLead();
  if (!canWrite || isTempLead(lead)) return <Badge tone={STATUS_TONE[lead.status]}>{lead.status}</Badge>;
  return (
    <span className={styles.leadStatus} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Select<sponsor.LeadStatus>
        id={`sponsor-lead-status-${lead.id}`}
        testId={`fe2-sponsor-lead-status-${lead.id}`}
        value={lead.status}
        disabled={update.isPending}
        options={sponsor.LEAD_STATUSES.map((s) => ({ value: s, label: s }))}
        onChange={(status) => {
          if (status !== lead.status) update.mutate({ lead, fields: { status } });
        }}
      />
    </span>
  );
}

function Stats({ leads }: { leads: readonly Lead[] }): JSX.Element {
  const s = summarizeLeads(leads);
  const items = [
    { key: "total", label: "登録企業数", value: s.total },
    { key: "contacted", label: "接触済", value: s.contacted },
    { key: "proposed", label: "提案済", value: s.proposed },
    { key: "agreed", label: "内諾・契約", value: s.agreed },
  ];
  return (
    <dl className={styles.statGrid} data-testid="fe2-sponsor-lead-stats">
      {items.map((i) => (
        <div key={i.key} className={styles.stat}>
          <dt>{i.label}</dt>
          <dd data-testid={`fe2-sponsor-lead-stat-${i.key}`}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SponsorLeadsScreen(): JSX.Element {
  const list = useLeads();
  const { canWrite } = useSponsorCapability();
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ key: "status", direction: "desc" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const all = list.data?.leads ?? [];
  const opened = all.find((l) => l.id === openId) ?? null;
  const today = todayIso();

  const statusOptions = useMemo(
    () =>
      sponsor.LEAD_STATUSES.map((s) => ({ value: s as string, label: s, count: all.filter((l) => l.status === s).length }))
        .filter((o) => o.count > 0)
        .map((o) => ({ ...o, testId: `fe2-sponsor-lead-filter-status-${o.value}` })),
    [all],
  );
  const ownerOptions = useMemo(
    () =>
      memberOptions(all, (l) => [ownerOf(l)], "fe2-sponsor-lead-filter-owner").map((o) =>
        o.value === UNKNOWN_MEMBER ? { ...o, label: "未設定" } : o,
      ),
    [all],
  );
  const { results } = useClientFilter(all, query, searchText);
  const rows = useMemo(
    () =>
      sortLeads(
        results.filter((l) => (statuses.length === 0 || statuses.includes(l.status)) && (owners.length === 0 || owners.includes(ownerOf(l)))),
        sort.key,
        sort.direction,
      ),
    [results, statuses, owners, sort],
  );
  const filterCount = statuses.length + owners.length;
  const filtering = filterCount > 0 || query.trim() !== "";
  const clearFilters = () => {
    setStatuses([]);
    setOwners([]);
  };

  const text = (key: keyof Lead, header: string, minWidth = "9rem"): ColumnDef<Lead> => ({
    key,
    header,
    minWidth,
    defaultHidden: true,
    cell: (l) => (l[key] as string | null) ?? "—",
  });
  const date = (key: "firstContactOn", header: string): ColumnDef<Lead> => ({
    key,
    header,
    noWrap: true,
    defaultHidden: true,
    cell: (l) => formatOn(l[key]),
  });

  const columns: ColumnDef<Lead>[] = [
    {
      key: "company",
      header: "企業名",
      sortable: true,
      hideable: false,
      minWidth: "12rem",
      cell: (l) => (
        <span className={styles.rowName} data-testid={`fe2-sponsor-lead-${l.id}`}>
          <span data-testid="fe2-sponsor-lead-name">{l.companyName}</span>
        </span>
      ),
    },
    { key: "status", header: "ステータス", sortable: true, hideable: false, cell: (l) => <StatusCell lead={l} /> },
    { key: "priority", header: "優先度", sortable: true, noWrap: true, cell: (l) => l.priority ?? "—" },
    { key: "owner", header: "営業担当", sortable: true, noWrap: true, cell: (l) => l.owner ?? "—" },
    { key: "plan", header: "検討プラン", sortable: true, noWrap: true, cell: (l) => l.plan ?? "—" },
    { key: "lastContactOn", header: "最終接触日", sortable: true, noWrap: true, cell: (l) => formatOn(l.lastContactOn) },
    { key: "nextAction", header: "次回アクション", minWidth: "12rem", cell: (l) => l.nextAction ?? "—" },
    {
      key: "nextActionOn",
      header: "次回アクション日",
      sortable: true,
      noWrap: true,
      cell: (l) =>
        isOverdue(l, today) ? (
          <span className={styles.leadNext}>
            {formatOn(l.nextActionOn)}
            <Badge tone="danger">期限切れ</Badge>
          </span>
        ) : (
          formatOn(l.nextActionOn)
        ),
    },
    text("industry", "業界"),
    text("contactName", "企業側担当者"),
    text("contactRole", "企業側部署・役職"),
    text("contactEmail", "担当者メール", "14rem"),
    text("source", "接点・紹介元"),
    text("contactType", "接点区分", "12rem"),
    date("firstContactOn", "初回連絡日"),
    { key: "amount", header: "想定協賛額", sortable: true, noWrap: true, align: "right", defaultHidden: true, cell: (l) => formatAmount(l.expectedAmount) },
    text("confidence", "確度", "4rem"),
    text("budgetPeriod", "予算年度・時期"),
    text("decisionPeriod", "決裁予定時期"),
    text("note", "メモ", "16rem"),
    text("evidence", "根拠・確認日", "16rem"),
  ];

  const addButtons = (
    <>
      <Button variant="secondary" testId="fe2-sponsor-lead-import-open" onClick={() => setImporting(true)}>
        スプレッドシートから取り込む
      </Button>
      <Button testId="fe2-sponsor-lead-add" onClick={() => setCreating(true)}>
        企業を追加
      </Button>
    </>
  );

  let body: JSX.Element;
  if (list.isLoading) {
    body = (
      <div data-testid="fe2-sponsor-leads-loading" aria-busy="true" aria-label="営業の進捗を読み込み中">
        <SkeletonTable rows={8} columns={8} />
      </div>
    );
  } else if (list.isError || !list.data) {
    body = (
      <ErrorState
        testId="fe2-sponsor-leads-error"
        error={{ code: "INTERNAL", message: "営業の進捗を読み込めませんでした。" }}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        testId="fe2-sponsor-leads-empty"
        icon="folder"
        title="まだ企業がありません"
        description={canWrite ? "声をかける企業を追加するか、今のスプレッドシートを貼り付けて取り込めます。" : "スポンサーチームが登録した企業がここに並びます。"}
      />
    );
  } else if (rows.length === 0 && filtering) {
    body = (
      <EmptyState
        testId="fe2-sponsor-leads-no-match"
        icon="search"
        title="条件に合う企業はありません"
        description="検索語や絞り込みを変えてみてください。"
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setQuery("");
              clearFilters();
            }}
          >
            条件をクリア
          </Button>
        }
      />
    );
  } else {
    body = (
      <DataTable<Lead>
        testId="fe2-sponsor-leads-table"
        columns={columns}
        rows={rows}
        rowKey={(l) => l.id}
        sort={sort}
        onSortChange={setSort}
        onRowClick={(l) => {
          if (!isTempLead(l)) setOpenId(l.id);
        }}
        columnHiding={{ storageKey: "fe2.sponsor.leads.columns" }}
      />
    );
  }

  return (
    <SponsorFrame active="leads" wide actions={canWrite ? addButtons : undefined}>
      <>
        {all.length > 0 ? <Stats leads={all} /> : null}
        {all.length > 0 ? (
          <div className={styles.toolbar}>
            <FilterBar
              testId="fe2-sponsor-leads-filters"
              aria-label="ステータスと営業担当で絞り込み"
              activeCount={filterCount}
              onClear={clearFilters}
              clearTestId="fe2-sponsor-leads-filter-clear"
            >
              <FilterChips multiple aria-label="ステータス" value={statuses} onChange={setStatuses} options={statusOptions} />
              <FilterChips multiple aria-label="営業担当" value={owners} onChange={setOwners} options={ownerOptions} />
            </FilterBar>
            <div className={styles.search}>
              <TextField
                id="sponsor-lead-search"
                testId="fe2-sponsor-leads-search"
                value={query}
                onChange={setQuery}
                placeholder="企業名・担当者・次回アクション・メモで検索"
              />
            </div>
          </div>
        ) : null}
        {body}
        <LeadDrawer lead={opened} onClose={() => setOpenId(null)} />
        <LeadCreateDrawer open={creating} onClose={() => setCreating(false)} />
        <LeadImportDialog open={importing} onClose={() => setImporting(false)} existing={all} />
      </>
    </SponsorFrame>
  );
}
