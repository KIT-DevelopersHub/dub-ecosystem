// スポンサー → 企業。名刺を会社名でまとめた表 (企業・名刺の枚数・先方の担当者・接点のあるメンバー・最終登録日)。
// 行を押すとその企業の名刺 (誰がいつ登録したか) をドロワーで出し、そこから名刺の詳細へ進める。
import { useMemo, useState } from "react";
import { DataTable, Drawer, EmptyState, ErrorState, SkeletonTable, TextField, type ColumnDef, type SortState } from "@dub/ui";
import { useCompanies } from "./sponsorHooks.ts";
import { companyKey, type Company } from "./companies.ts";
import { CardDrawer } from "./CardDrawer.tsx";
import { formatDate, formatDateTime } from "./SponsorShared.tsx";
import { SponsorFrame } from "./SponsorCardsScreen.tsx";
import styles from "./sponsor.module.css";

const people = (c: Company) => [...new Set(c.cards.map((x) => x.personName).filter((n): n is string => !!n))];

function sortCompanies(rows: Company[], sort: SortState): Company[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const cmp: Record<string, (a: Company, b: Company) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, "ja"),
    count: (a, b) => a.cards.length - b.cards.length,
    lastAt: (a, b) => a.lastAt.localeCompare(b.lastAt),
  };
  const f = cmp[sort.key] ?? cmp.lastAt!;
  return [...rows].sort((a, b) => f(a, b) * dir);
}

function CompanyDrawer({ company, onClose, onOpenCard }: { company: Company | null; onClose: () => void; onOpenCard: (id: string) => void }): JSX.Element {
  return (
    <Drawer testId="fe2-sponsor-company-drawer" open={company !== null} onClose={onClose} title={company?.name ?? "企業"}>
      {company ? (
        <div className={styles.companyBody} data-testid="fe2-sponsor-company-detail">
          <p className={styles.note}>
            名刺 {company.cards.length} 枚・接点のあるメンバー {company.members.join("、") || "—"}
          </p>
          <ul className={styles.companyCards}>
            {company.cards.map((c) => (
              <li key={c.id}>
                <button type="button" className={styles.companyCard} data-testid={`fe2-sponsor-company-card-${c.id}`} onClick={() => onOpenCard(c.id)}>
                  <span className={styles.companyCardName}>{[c.personName, c.title].filter(Boolean).join("・") || "氏名未入力"}</span>
                  <span className={styles.muted}>
                    {c.createdByName ?? "—"} が登録・{formatDateTime(c.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Drawer>
  );
}

export function SponsorCompaniesScreen(): JSX.Element {
  const { list, companies, unassigned } = useCompanies();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "lastAt", direction: "desc" });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim();
    const k = q === "" ? "" : companyKey(q);
    const hit = (c: Company) =>
      q === "" || c.key.includes(k) || [...people(c), ...c.members].some((n) => n.toLowerCase().includes(q.toLowerCase()));
    return sortCompanies(companies.filter(hit), sort);
  }, [companies, query, sort]);
  const opened = companies.find((c) => c.key === openKey) ?? null;

  const columns: ColumnDef<Company>[] = [
    {
      key: "name",
      header: "企業",
      sortable: true,
      hideable: false,
      minWidth: "12rem",
      cell: (c) => (
        <button
          type="button"
          className={styles.rowLink}
          data-testid={`fe2-sponsor-company-${c.key}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpenKey(c.key);
          }}
        >
          {c.name}
        </button>
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
  } else if (rows.length === 0) {
    body = <p className={styles.note} data-testid="fe2-sponsor-companies-no-match">「{query.trim()}」に合う企業はありません。</p>;
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
            <div className={styles.search}>
              <TextField
                id="sponsor-company-search"
                testId="fe2-sponsor-companies-search"
                value={query}
                onChange={setQuery}
                placeholder="企業名・担当者・メンバーで検索"
              />
            </div>
            <span className={styles.count}>{rows.length} 社</span>
          </div>
        ) : null}
        {body}
        {unassigned > 0 && list.data ? (
          <p className={styles.note} data-testid="fe2-sponsor-unassigned">
            会社名が未入力の名刺が {unassigned} 枚あります（「名刺」タブから入力すると企業にまとまります）。
          </p>
        ) : null}
        <CompanyDrawer
          company={cardId ? null : opened}
          onClose={() => setOpenKey(null)}
          onOpenCard={(id) => setCardId(id)}
        />
        <CardDrawer cardId={cardId} onClose={() => setCardId(null)} />
      </>
    </SponsorFrame>
  );
}
