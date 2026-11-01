// 人事 → 応募者 (表)。1 人 1 行のスプレッドシート風の一覧。
//  - 上にステータスの絞り込み (件数つき): すべて / オンボーディング前 / 各ステータス。
//    「オンボーディング前」= 採用 + オンボーディング調整 (採用済みでオンボーディングが終わっていない人)。
//  - 列見出しで並べ替え、氏名・フリガナ・学科で検索。
//  - ステータスは行のプルダウンでその場で変えられる (楽観的 UI・失敗で戻る)。名簿にいない人を採用系に
//    するときだけ確認ダイアログ → 名簿に追加。
//  - 行を押すと詳細ドロワー (面談日・メモ・履歴)。
import { useMemo, useState } from "react";
import {
  Button,
  Card,
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
import { hr } from "@dub/types";
import { useApplicants, useHrTeams } from "./hrHooks.ts";
import {
  ApplicantDrawer,
  formatDate,
  formatDateTime,
  JoinConfirmDialog,
  NewApplicantModal,
  StageBadge,
  STAGE_LABELS,
  StatusSelect,
  useHrCapability,
  type JoinRequest,
} from "./HrShared.tsx";
import { HrTabs, type HrTabId } from "./HrTabs.tsx";
import styles from "./hr.module.css";

export function HrFrame({ active, children }: { active: HrTabId; children: JSX.Element }): JSX.Element {
  const { canWrite } = useHrCapability();
  const [creating, setCreating] = useState(false);
  return (
    <Stack gap={6} testId={`fe2-hr-${active}-screen`}>
      <PageHeader
        testId="fe2-hr-header"
        title="人事"
        description="面談から採用・オンボーディングまでを一覧で管理します。採用した人は運営メンバー・名簿に追加されます。"
        actions={
          canWrite && active === "applicants" ? (
            <Button testId="fe2-hr-new" onClick={() => setCreating(true)}>
              応募者を登録
            </Button>
          ) : undefined
        }
      />
      <HrTabs active={active} />
      {children}
      <NewApplicantModal open={creating} onClose={() => setCreating(false)} />
    </Stack>
  );
}

/** 絞り込み。"all" / "before_onboarding" / 各ステータス。 */
export type HrFilter = "all" | "before_onboarding" | hr.ApplicantStage;

export const FILTERS: { id: HrFilter; label: string; match: (s: hr.ApplicantStage) => boolean }[] = [
  { id: "all", label: "すべて", match: () => true },
  { id: "before_onboarding", label: "オンボーディング前", match: (s) => hr.BEFORE_ONBOARDING_STAGES.includes(s) },
  ...hr.APPLICANT_STAGES.map((s) => ({ id: s as HrFilter, label: STAGE_LABELS[s], match: (x: hr.ApplicantStage) => x === s })),
];

const STAGE_ORDER = new Map(hr.APPLICANT_STAGES.map((s, i) => [s, i]));

function compare(a: hr.ApplicantListItem, b: hr.ApplicantListItem, key: string, teamName: (id: string | null) => string): number {
  const str = (x: string | null | undefined) => x ?? "";
  switch (key) {
    case "name":
      return str(a.nameKana ?? a.name).localeCompare(str(b.nameKana ?? b.name), "ja");
    case "dept":
      return `${str(a.department)}${str(a.grade)}`.localeCompare(`${str(b.department)}${str(b.grade)}`, "ja");
    case "team":
      return teamName(a.desiredTeamId).localeCompare(teamName(b.desiredTeamId), "ja");
    case "stage":
      return (STAGE_ORDER.get(a.stage) ?? 0) - (STAGE_ORDER.get(b.stage) ?? 0);
    case "interview":
      // 未設定は常に後ろ。
      if (!a.interviewAt || !b.interviewAt) return a.interviewAt ? -1 : b.interviewAt ? 1 : 0;
      return a.interviewAt.localeCompare(b.interviewAt);
    case "updated":
      return a.updatedAt.localeCompare(b.updatedAt);
    default:
      return 0;
  }
}

export function HrApplicantsScreen(): JSX.Element {
  const list = useApplicants();
  const teams = useHrTeams();
  const { canWrite } = useHrCapability();
  const [filter, setFilter] = useState<HrFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "updated", direction: "desc" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [joinReq, setJoinReq] = useState<JoinRequest | null>(null);
  const teamName = (id: string | null) => teams.data?.teams.find((t) => t.id === id)?.name ?? "";

  const all = list.data?.applicants ?? [];
  const counts = useMemo(() => new Map(FILTERS.map((f) => [f.id, all.filter((a) => f.match(a.stage)).length])), [all]);

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const q = query.trim().toLowerCase();
    const filtered = all.filter(
      (a) =>
        f.match(a.stage) &&
        (q === "" || [a.name, a.nameKana, a.department].some((v) => v?.toLowerCase().includes(q))),
    );
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => compare(a, b, sort.key, teamName) * dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filter, query, sort, teams.data]);

  const columns: ColumnDef<hr.ApplicantListItem>[] = [
    {
      key: "name",
      header: "氏名",
      sortable: true,
      noWrap: true,
      minWidth: "9rem",
      cell: (a) => (
        <span className={styles.cardName} data-testid={`fe2-hr-row-${a.id}`}>
          {a.name}
        </span>
      ),
    },
    { key: "dept", header: "学科・学年", sortable: true, minWidth: "10rem", cell: (a) => [a.department, a.grade].filter(Boolean).join(" ") || "—" },
    { key: "team", header: "希望チーム", sortable: true, noWrap: true, cell: (a) => teamName(a.desiredTeamId) || "未定" },
    {
      key: "stage",
      header: "ステータス",
      sortable: true,
      noWrap: true,
      minWidth: "13rem",
      cell: (a) =>
        canWrite ? (
          <StatusSelect applicant={a} onRequestJoin={setJoinReq} testId={`fe2-hr-row-${a.id}-status`} />
        ) : (
          <StageBadge stage={a.stage} />
        ),
    },
    { key: "interview", header: "面談日", sortable: true, noWrap: true, cell: (a) => formatDateTime(a.interviewAt) },
    { key: "updated", header: "更新日", sortable: true, noWrap: true, cell: (a) => formatDate(a.updatedAt) },
    {
      key: "note",
      header: "メモ",
      minWidth: "14rem",
      cell: (a) => <span className={styles.noteCell}>{a.latestNote ?? ""}</span>,
    },
  ];

  let body: JSX.Element;
  if (list.isLoading) {
    body = (
      <Card padded={false} testId="fe2-hr-loading">
        <SkeletonTable rows={8} columns={7} />
      </Card>
    );
  } else if (list.isError || !list.data) {
    body = (
      <ErrorState
        testId="fe2-hr-error"
        error={{ code: "INTERNAL", message: "応募者を読み込めませんでした。" }}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (all.length === 0) {
    body = <EmptyState testId="fe2-hr-empty" icon="user" title="まだ応募者がいません" description="「応募者を登録」から追加できます。" />;
  } else {
    body = (
      <DataTable<hr.ApplicantListItem>
        testId="fe2-hr-table"
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        sort={sort}
        onSortChange={setSort}
        onRowClick={(a) => setOpenId(a.id)}
        emptyState={<div className={styles.note}>条件に合う応募者はいません。</div>}
      />
    );
  }

  return (
    <HrFrame active="applicants">
      <>
        <div className={styles.toolbar}>
          <FilterBar
            testId="fe2-hr-filters"
            aria-label="ステータスで絞り込み"
            activeCount={filter === "all" ? 0 : 1}
            onClear={() => setFilter("all")}
            clearTestId="fe2-hr-filter-clear"
          >
            <FilterChips
              aria-label="ステータス"
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({
                value: f.id,
                label: f.label,
                count: list.data ? counts.get(f.id) ?? 0 : "–",
                testId: `fe2-hr-filter-${f.id}`,
                countTestId: `fe2-hr-filter-${f.id}-count`,
              }))}
            />
          </FilterBar>
          <div className={styles.search}>
            <TextField id="hr-search" testId="fe2-hr-search" value={query} onChange={setQuery} placeholder="氏名・フリガナ・学科で検索" />
          </div>
        </div>
        {body}
        <ApplicantDrawer applicantId={openId} onClose={() => setOpenId(null)} onRequestJoin={setJoinReq} />
        <JoinConfirmDialog request={joinReq} onDone={() => setJoinReq(null)} />
      </>
    </HrFrame>
  );
}
