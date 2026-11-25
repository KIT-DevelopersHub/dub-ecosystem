// スポンサー → 企業。名刺を会社名でまとめた表 (企業・名刺の枚数・先方の担当者・接点のあるメンバー・最終登録日)。
// 接点のあるメンバーで絞り込み (FilterBar + FilterChips)・企業名/担当者/メンバーで検索 (useClientFilter)。
// 行を押すとその企業の名刺 (誰がいつ登録したか) の表をドロワーで出し、そこから名刺の詳細へ進める。
import { useMemo, useState } from "react";
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChips,
  SkeletonTable,
  Stack,
  TextField,
  type ColumnDef,
  type SortState,
} from "@dub/ui";
import { useClientFilter } from "@dub/app-ui";
import type { sponsor } from "@dub/types";
import { useCompanies } from "./sponsorHooks.ts";
import type { Company } from "./companies.ts";
import { CardDrawer } from "./CardDrawer.tsx";
import { formatDate, formatDateTime, memberOptions } from "./SponsorShared.tsx";
import { SponsorFrame } from "./SponsorCardsScreen.tsx";
import styles from "./sponsor.module.css";

const people = (c: Company) => [...new Set(c.cards.map((x) => x.personName).filter((n): n is string => !!n))];

const searchText = (c: Company): string =>
  [...new Set(c.cards.map((x) => x.companyName ?? "")), ...people(c), ...c.members].join(" ");

function sortCompanies(rows: readonly Company[], sort: SortState): Company[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const cmp: Record<string, (a: Company, b: Company) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, "ja"),
    count: (a, b) => a.cards.length - b.cards.length,
    lastAt: (a, b) => a.lastAt.localeCompare(b.lastAt),
  };
  const f = cmp[sort.key] ?? cmp.lastAt!;
  return [...rows].sort((a, b) => f(a, b) * dir);
}

const CARD_COLUMNS: ColumnDef<sponsor.BusinessCard>[] = [
  {
    key: "person",
    header: "先方の担当者",
    hideable: false,
    minWidth: "9rem",
    cell: (c) => (
      <span className={styles.rowName} data-testid={`fe2-sponsor-company-card-${c.id}`}>
        {[c.personName, c.title].filter(Boolean).join("・") || "氏名未入力"}
      </span>
    ),
  },
  { key: "createdBy", header: "登録者", noWrap: true, cell: (c) => c.createdByName ?? "—" },
  { key: "createdAt", header: "登録日時", noWrap: true, cell: (c) => formatDateTime(c.createdAt) },
];

function CompanyDrawer({ company, onClose, onOpenCard }: { company: Company | null; onClose: () => void; onOpenCard: (id: string) => void }): JSX.Element {
  return (
    <Drawer testId="fe2-sponsor-company-drawer" open={company !== null} onClose={onClose} title={company?.name ?? "企業"}>
      {company ? (
        <Stack gap={5} testId="fe2-sponsor-company-detail">
          <p className={styles.note}>
            名刺 {company.cards.length} 枚・接点のあるメンバー {company.members.join("、") || "—"}
          </p>
          <DataTable<sponsor.BusinessCard>
            testId="fe2-sponsor-company-cards"
            columns={CARD_COLUMNS}
            rows={company.cards}
            rowKey={(c) => c.id}
            onRowClick={(c) => onOpenCard(c.id)}
          />
        </Stack>
      ) : null}
    </Drawer>
  );
}

export function SponsorCompaniesScreen(): JSX.Element {
  const { list, companies, unassigned } = useCompanies();
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ key: "lastAt", direction: "desc" });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);

  const options = useMemo(() => memberOptions(companies, (c) => c.members, "fe2-sponsor-companies-filter-member"), [companies]);
  const { results } = useClientFilter(companies, query, searchText);
  const rows = useMemo(
    () => sortCompanies(members.length === 0 ? results : results.filter((c) => c.members.some((m) => members.includes(m))), sort),
    [results, members, sort],
  );
  const filtering = members.length > 0 || query.trim() !== "";
  const opened = companies.find((c) => c.key === openKey) ?? null;

  const columns: ColumnDef<Company>[] = [
    {
      key: "name",
      header: "企業",
      sortable: true,
      hideable: false,
      minWidth: "12rem",
      cell: (c) => (
        <span className={styles.rowName} data-testid={`fe2-sponsor-company-${c.key}`}>
          {c.name}
        </span>
      ),
    },
    { key: "count", header: "名刺", sortable: true, noWrap: true, align: "right", cell: (c) => `${c.cards.length} 枚` },
    { key: "people", header: "先方の担当者", minWidth: "10rem", cell: (c) => people(c).join("、") || "—" },
    { key: "members", header: "接点のあるメンバー", minWidth: "10rem", cell: (c) => c.members.join("、") || "—" },
    { key: "lastAt", header: "最終登録日", sortable: true, noWrap: true, cell: (c) => formatDate(c.lastAt) },
  ];

  let body: JSX.Element;
  if (list.isLoading) {
    body = (
      <div data-testid="fe2-sponsor-companies-loading" aria-busy="true" aria-label="企業を読み込み中">
        <SkeletonTable rows={5} columns={5} />
      </div>
    );
  } else if (list.isError || !list.data) {
    body = (
      <ErrorState
        testId="fe2-sponsor-companies-error"
        error={{ code: "INTERNAL", message: "企業を読み込めませんでした。" }}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (companies.length === 0) {
    body = (
      <EmptyState
        testId="fe2-sponsor-companies-empty"
        icon="folder"
        title="まだ企業がありません"
        description="名刺に会社名を入れると、企業ごとにまとまってここに並びます。"
      />
    );
  } else if (rows.length === 0 && filtering) {
    body = (
      <EmptyState
        testId="fe2-sponsor-companies-no-match"
        icon="search"
        title="条件に合う企業はありません"
        description="検索語やメンバーの絞り込みを変えてみてください。"
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setQuery("");
              setMembers([]);
            }}
          >
            条件をクリア
          </Button>
        }
      />
    );
  } else {
    body = (
      <DataTable<Company>
        testId="fe2-sponsor-companies-table"
        columns={columns}
        rows={rows}
        rowKey={(c) => c.key}
        sort={sort}
        onSortChange={setSort}
        onRowClick={(c) => setOpenKey(c.key)}
      />
    );
  }

  return (
    <SponsorFrame active="companies">
      <>
        {companies.length > 0 ? (
          <div className={styles.toolbar}>
            <FilterBar
              testId="fe2-sponsor-companies-filters"
              aria-label="接点のあるメンバーで絞り込み"
              activeCount={members.length}
              onClear={() => setMembers([])}
              clearTestId="fe2-sponsor-companies-filter-clear"
            >
              <FilterChips multiple aria-label="接点のあるメンバー" value={members} onChange={setMembers} options={options} />
            </FilterBar>
            <div className={styles.search}>
              <TextField
                id="sponsor-company-search"
                testId="fe2-sponsor-companies-search"
                value={query}
                onChange={setQuery}
                placeholder="企業名・担当者・メンバーで検索"
              />
            </div>
          </div>
        ) : null}
        {body}
        {unassigned > 0 && list.data ? (
          <p className={styles.note} data-testid="fe2-sponsor-unassigned">
            会社名が未入力の名刺が {unassigned} 枚あります（「名刺」タブから入力すると企業にまとまります）。
          </p>
        ) : null}
        <CompanyDrawer company={cardId ? null : opened} onClose={() => setOpenKey(null)} onOpenCard={setCardId} />
        <CardDrawer cardId={cardId} onClose={() => setCardId(null)} />
      </>
    </SponsorFrame>
  );
}
