// LP管理 → ログ管理タブ。発行した流入URL経由の訪問と LP 側のページビューを、
// 期間(7/30/90日)・KPI・流入元別内訳・日別・生ログ で読む read-only ダッシュボード。
//
// 設計メモ:
//  - 読み取り専用なので楽観的 UI は不要。代わりに 3 状態（スケルトン / 空 / 失敗+再試行）を
//    必ず作り込む（「データ無し」と「読み込み中」を混同させない）。
//  - refetchInterval は付けない。staleTime を長めに取り、タブ往復での無駄な再フェッチも抑える
//    （Cloudflare 無料枠の読み取りを食い潰さない）。
//  - 期間は日単位の閉区間（lpRange.rangeForDays）。タイムスタンプにするとレンダー毎に
//    queryKey が変わって無限再フェッチになるため。
//  - 数値は「総訪問(のべ)」と「一意訪問者」を必ず注記付きで並記する。注記なしに並べると
//    どちらが人数なのか読み違えるため（プロダクトデザイナー観点の必須対応）。
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  SegmentedControl,
  SkeletonLoader,
  Stack,
  type ColumnDef,
} from "@dub/ui";
import { useLpApi } from "./LpProvider.tsx";
import type { LpVisit } from "./lpApi.tsx";
import {
  LP_DEFAULT_RANGE_DAYS,
  LP_RANGE_DAYS,
  countryLabel,
  deviceLabel,
  formatCount,
  formatDayLabel,
  formatVisitTime,
  rangeForDays,
  rangeLabel,
  sourceLabel,
  type LpRangeDays,
} from "./lpRange.ts";
import { LpTabs } from "./LpTabs.tsx";
import { SourceBars } from "./SourceBars.tsx";
import styles from "./lp.module.css";

/** 1 ページの生ログ件数。大きくしすぎると初回描画が重くなるので控えめに。 */
const VISITS_PAGE_SIZE = 25;
/** 同じ期間を見ている間は再取得しない（無料枠の読み取り削減）。 */
const STALE_MS = 5 * 60 * 1000;

function KpiCard({
  testId,
  label,
  value,
  hint,
}: {
  testId: string;
  label: string;
  value: number;
  hint: string;
}): JSX.Element {
  return (
    <Card testId={testId}>
      <Stack gap={1}>
        <span className={styles.kpiLabel}>{label}</span>
        <span className={styles.kpiValue}>{formatCount(value)}</span>
        <span className={styles.kpiHint}>{hint}</span>
      </Stack>
    </Card>
  );
}

const DAY_COLUMNS: ColumnDef<{ date: string; visits: number }>[] = [
  { key: "date", header: "日付", cell: (r) => formatDayLabel(r.date), width: "8rem", noWrap: true },
  {
    key: "visits",
    header: "訪問",
    align: "right",
    width: "8rem",
    cell: (r) => <span className={styles.num}>{formatCount(r.visits)}</span>,
  },
];

const VISIT_COLUMNS: ColumnDef<LpVisit>[] = [
  { key: "occurredAt", header: "時刻", cell: (v) => formatVisitTime(v.occurredAt), width: "9rem", noWrap: true },
  { key: "source", header: "流入元", cell: (v) => sourceLabel(v.source), width: "10rem" },
  { key: "device", header: "デバイス", cell: (v) => deviceLabel(v.device), width: "7rem", noWrap: true },
  { key: "country", header: "国", cell: (v) => countryLabel(v.country), width: "6rem", noWrap: true },
  {
    key: "referrerHost",
    header: "リファラ",
    minWidth: "12rem",
    // 直接アクセスは referrer が無いのが正常。空欄にせず「なし」と書いて欠損と区別する。
    cell: (v) => v.referrerHost ?? "なし",
  },
];

export function LpVisitLogScreen(): JSX.Element {
  const api = useLpApi();
  const [days, setDays] = useState<LpRangeDays>(LP_DEFAULT_RANGE_DAYS);
  // days が変わった時だけ日付を再計算する（毎レンダーで new Date() を評価しない）。
  const range = useMemo(() => rangeForDays(days), [days]);

  const stats = useQuery({
    queryKey: ["lp", "stats", range.from, range.to] as const,
    queryFn: () => api.getStats({ from: range.from, to: range.to, includeBots: false }),
    staleTime: STALE_MS,
  });

  const visits = useInfiniteQuery({
    queryKey: ["lp", "visits", range.from, range.to] as const,
    queryFn: ({ pageParam }) =>
      api.listVisits({
        from: range.from,
        to: range.to,
        limit: VISITS_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE_MS,
  });

  const rows = useMemo(() => visits.data?.pages.flatMap((p) => p.items) ?? [], [visits.data]);
  const byDay = useMemo(() => (stats.data?.byDay ?? []).slice().reverse(), [stats.data]);

  const header = (
    <PageHeader
      testId="fe2-lp-visits-header"
      title="LP管理"
      description="LP(ランディングページ)への流入ログを見ます。発行した流入URL経由の訪問と、LP のページビューを集計します。"
    />
  );

  const rangePicker = (
    <SegmentedControl<string>
      testId="fe2-lp-range"
      aria-label="集計期間"
      caption="集計期間"
      captionTestId="fe2-lp-range-caption"
      value={String(days)}
      options={LP_RANGE_DAYS.map((d) => ({
        value: String(d),
        label: rangeLabel(d),
        testId: `fe2-lp-range-${d}`,
      }))}
      onChange={(v) => setDays(Number(v) as LpRangeDays)}
    />
  );

  let body: JSX.Element;
  if (stats.isLoading || visits.isLoading) {
    // 読み込み中は「KPI 4枚 + 内訳 + 表」の骨組みをスケルトンで先に出す（空状態と区別）。
    body = (
      <Stack gap={6} testId="fe2-lp-visits-loading">
        <div className={styles.kpiGrid}>
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <SkeletonLoader lines={2} />
            </Card>
          ))}
        </div>
        <Card>
          <SkeletonLoader lines={5} />
        </Card>
        <Card>
          <SkeletonLoader lines={6} />
        </Card>
      </Stack>
    );
  } else if (stats.isError || visits.isError) {
    body = (
      <ErrorState
        testId="fe2-lp-visits-error"
        error={{ code: "INTERNAL", message: "流入ログを読み込めませんでした。" }}
        onRetry={() => {
          if (stats.isError) void stats.refetch();
          if (visits.isError) void visits.refetch();
        }}
      />
    );
  } else if (!stats.data || (stats.data.totals.visits === 0 && rows.length === 0)) {
    body = (
      <EmptyState
        testId="fe2-lp-visits-empty"
        icon="megaphone"
        title="まだログがありません"
        description="流入URLを発行して共有すると計測が始まります。すでに共有済みなら、期間を広げると過去の訪問が見えることがあります。"
      />
    );
  } else {
    const totals = stats.data.totals;
    body = (
      <Stack gap={8} testId="fe2-lp-visits-body">
        <div className={styles.kpiGrid}>
          <KpiCard
            testId="fe2-lp-kpi-visits"
            label="総訪問(のべ)"
            value={totals.visits}
            hint="同じ人の2回目以降も数えた延べ回数"
          />
          <KpiCard
            testId="fe2-lp-kpi-uniques"
            label="一意訪問者(人)"
            value={totals.uniques}
            hint="同じ端末からの再訪は1人として数えた推定人数"
          />
          <KpiCard
            testId="fe2-lp-kpi-sources"
            label="流入元の数"
            value={stats.data.bySource.length}
            hint="この期間に1件以上訪問があった流入元の種類"
          />
          <KpiCard
            testId="fe2-lp-kpi-bots"
            label="bot除外"
            value={totals.botExcluded}
            hint="クローラー等と判定して上の数字から除いた件数"
          />
        </div>

        <Card testId="fe2-lp-sources" header={<span className={styles.sectionTitle}>流入元別の内訳</span>}>
          <Stack gap={5}>
            <SourceBars buckets={stats.data.bySource} />
            <span className={styles.note}>
              棒の長さは総訪問(のべ)の多い順です。カッコ内は同期間の総訪問に対する構成比です。
            </span>
          </Stack>
        </Card>

        <Card testId="fe2-lp-devices" header={<span className={styles.sectionTitle}>デバイス別の内訳</span>}>
          <SourceBars buckets={stats.data.byDevice} />
        </Card>

        <Card testId="fe2-lp-byday" header={<span className={styles.sectionTitle}>日別の訪問</span>}>
          <DataTable<{ date: string; visits: number }>
            testId="fe2-lp-byday-table"
            columns={DAY_COLUMNS}
            rows={byDay}
            rowKey={(r) => r.date}
            emptyState={<EmptyState title="この期間の日別データがありません" icon="megaphone" />}
          />
        </Card>

        <Card testId="fe2-lp-visits" header={<span className={styles.sectionTitle}>生ログ(新しい順)</span>}>
          <Stack gap={5}>
            <DataTable<LpVisit>
              testId="fe2-lp-visits-table"
              columns={VISIT_COLUMNS}
              rows={rows}
              rowKey={(v) => v.id}
              emptyState={<EmptyState title="この期間のログがありません" icon="megaphone" />}
            />
            <LoadMore
              testId="fe2-lp-visits-more"
              hasMore={visits.hasNextPage}
              loading={visits.isFetchingNextPage}
              label="もっと見る"
              onLoadMore={() => void visits.fetchNextPage()}
            />
            <span className={styles.note}>
              {formatCount(rows.length)}件を表示中（{rangeLabel(days)}・bot は除外）
            </span>
          </Stack>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap={6} testId="fe2-lp-visits-screen">
      {header}
      <LpTabs active="visits" />
      {rangePicker}
      {body}
    </Stack>
  );
}
