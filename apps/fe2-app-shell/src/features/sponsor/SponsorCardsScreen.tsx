// スポンサー → 名刺 (名簿形式の表)。写真・会社・氏名・部署/役職・連絡先・登録者・登録日時 (既定 = 新しい順)。
// 登録者で絞り込み (FilterBar + FilterChips)・会社名/氏名/部署/メモ/登録者で検索 (useClientFilter)。
// 行を押すと詳細ドロワー。主ボタン「名刺をスキャン」は sponsor:write の人だけ。
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChips,
  PageHeader,
  SkeletonTable,
  Stack,
  TextField,
  type ColumnDef,
  type SortState,
} from "@dub/ui";
import { useClientFilter } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { isTempCard, useCards } from "./sponsorHooks.ts";
import { CardDrawer } from "./CardDrawer.tsx";
import { CardPhoto, formatDateTime, memberOf, memberOptions, RetryUpload, useSponsorCapability } from "./SponsorShared.tsx";
import { SponsorTabs, type SponsorTabId } from "./SponsorTabs.tsx";
import styles from "./sponsor.module.css";

export const SCAN_PATH = "/sponsor/scan";

type Card = sponsor.BusinessCard;

const searchText = (c: Card): string => [c.companyName, c.personName, c.department, c.note, c.createdByName].filter(Boolean).join(" ");

const SORT_VALUE: Record<string, (c: Card) => string> = {
  company: (c) => c.companyName ?? "",
  person: (c) => c.personName ?? "",
  createdBy: (c) => c.createdByName ?? "",
  createdAt: (c) => c.createdAt,
};

function sortRows(rows: Card[], sort: SortState): Card[] {
  const get = SORT_VALUE[sort.key] ?? SORT_VALUE.createdAt!;
  const dir = sort.direction === "asc" ? 1 : -1;
  // 空欄は向きに関係なく末尾。
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === "" || y === "") return x === y ? 0 : x === "" ? 1 : -1;
    return x.localeCompare(y, "ja") * dir;
  });
}

export function SponsorFrame({
  active,
  actions,
  wide = false,
  children,
}: {
  active: SponsorTabId;
  actions?: JSX.Element;
  /** 列の多い表向けに横幅を広げる。 */
  wide?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className={`${styles.page} ${wide ? styles.pageWide : ""}`}>
      <Stack gap={6} testId={`fe2-sponsor-${active}-screen`}>
        <PageHeader
          testId="fe2-sponsor-header"
          title="スポンサー"
          description="スポンサーチームで受け取った名刺と、つながりのある企業、営業の進捗と目標を共有します。"
          actions={actions}
        />
        <SponsorTabs active={active} />
        {children}
      </Stack>
    </div>
  );
}

export function SponsorCardsScreen(): JSX.Element {
  const list = useCards();
  const navigate = useNavigate();
  const { canWrite } = useSponsorCapability();
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ key: "createdAt", direction: "desc" });
  const [openId, setOpenId] = useState<string | null>(null);
  const scan = () => void navigate({ to: SCAN_PATH });
  const open = (c: Card) => {
    if (!isTempCard(c)) setOpenId(c.id);
  };

  const all = list.data?.cards ?? [];
  const options = useMemo(() => memberOptions(all, (c) => [memberOf(c)], "fe2-sponsor-filter-member"), [all]);
  const { results } = useClientFilter(all, query, searchText);
  const rows = useMemo(
    () => sortRows(members.length === 0 ? [...results] : results.filter((c) => members.includes(memberOf(c))), sort),
    [results, members, sort],
  );
  const filtering = members.length > 0 || query.trim() !== "";

  const columns: ColumnDef<Card>[] = [
    {
      key: "photo",
      header: "写真",
      hideable: false,
      width: "7rem",
      cell: (c) => (
        <div className={styles.cellPhoto}>
          <CardPhoto card={c} />
          <RetryUpload card={c} />
        </div>
      ),
    },
    {
      key: "company",
      header: "会社",
      sortable: true,
      hideable: false,
      minWidth: "11rem",
      cell: (c) => (
        <span className={styles.rowName} data-testid={`fe2-sponsor-card-${c.id}`}>
          <span data-testid="fe2-sponsor-card-name">{c.companyName ?? sponsor.cardDisplayName(c)}</span>
        </span>
      ),
    },
    { key: "person", header: "氏名", sortable: true, noWrap: true, cell: (c) => (c.companyName ? c.personName : null) ?? "—" },
    { key: "role", header: "部署・役職", minWidth: "9rem", cell: (c) => [c.department, c.title].filter(Boolean).join(" ") || "—" },
    { key: "email", header: "メール", noWrap: true, defaultHidden: true, cell: (c) => c.email ?? "—" },
    { key: "phone", header: "電話", noWrap: true, defaultHidden: true, cell: (c) => c.phone ?? "—" },
    { key: "createdBy", header: "登録者", sortable: true, noWrap: true, cell: (c) => c.createdByName ?? "—" },
    {
      key: "createdAt",
      header: "登録日時",
      sortable: true,
      noWrap: true,
      cell: (c) => (isTempCard(c) ? <Badge tone="info">保存中…</Badge> : formatDateTime(c.createdAt)),
    },
  ];

  let body: JSX.Element;
  if (list.isLoading) {
    body = (
      <div data-testid="fe2-sponsor-loading" aria-busy="true" aria-label="名刺を読み込み中">
        <SkeletonTable rows={6} columns={6} />
      </div>
    );
  } else if (list.isError || !list.data) {
    body = (
      <ErrorState
        testId="fe2-sponsor-error"
        error={{ code: "INTERNAL", message: "名刺を読み込めませんでした。" }}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        testId="fe2-sponsor-empty"
        icon="folder"
        title="まだ名刺がありません"
        description={canWrite ? "受け取った名刺を撮影すると、スポンサーチームの全員で見られます。" : "スポンサーチームが登録した名刺がここに並びます。"}
        action={
          canWrite ? (
            <Button size="lg" testId="fe2-sponsor-empty-scan" onClick={scan}>
              名刺をスキャン
            </Button>
          ) : undefined
        }
      />
    );
  } else if (rows.length === 0 && filtering) {
    body = (
      <EmptyState
        testId="fe2-sponsor-no-match"
        icon="search"
        title="条件に合う名刺はありません"
        description="検索語や登録者の絞り込みを変えてみてください。"
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
      <DataTable<Card>
        testId="fe2-sponsor-table"
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id}
        sort={sort}
        onSortChange={setSort}
        onRowClick={open}
        columnHiding={{ storageKey: "fe2.sponsor.cards.columns" }}
      />
    );
  }

  return (
    <SponsorFrame
      active="cards"
      actions={
        canWrite ? (
          <Button testId="fe2-sponsor-scan" onClick={scan}>
            名刺をスキャン
          </Button>
        ) : undefined
      }
    >
      <>
        {all.length > 0 ? (
          <div className={styles.toolbar}>
            <FilterBar
              testId="fe2-sponsor-filters"
              aria-label="登録者で絞り込み"
              activeCount={members.length}
              onClear={() => setMembers([])}
              clearTestId="fe2-sponsor-filter-clear"
            >
              <FilterChips multiple aria-label="登録者" value={members} onChange={setMembers} options={options} />
            </FilterBar>
            <div className={styles.search}>
              <TextField
                id="sponsor-search"
                testId="fe2-sponsor-search"
                value={query}
                onChange={setQuery}
                placeholder="会社名・氏名・部署・メモ・登録者で検索"
              />
            </div>
          </div>
        ) : null}
        {body}
        <CardDrawer cardId={openId} onClose={() => setOpenId(null)} />
      </>
    </SponsorFrame>
  );
}
