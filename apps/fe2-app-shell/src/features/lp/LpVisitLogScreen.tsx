// LP管理 → ログ管理タブ。発行した流入URL経由の訪問と LP 側のページビューを、
// 期間(7/30/90日 or カレンダーで指定)・流入元の絞り込み・KPI・流入元別内訳・日別・生ログ で読む
// read-only ダッシュボード。
//
// 設計メモ:
//  - 読み取り専用なので楽観的 UI は不要。代わりに 3 状態（スケルトン / 空 / 失敗+再試行）を
//    必ず作り込む（「データ無し」と「読み込み中」を混同させない）。
//  - refetchInterval は付けない。staleTime を長めに取り、タブ往復での無駄な再フェッチも抑える
//    （Cloudflare 無料枠の読み取りを食い潰さない）。
//  - 期間は日単位の閉区間（lpRange.rangeForDays）。タイムスタンプにするとレンダー毎に
//    queryKey が変わって無限再フェッチになるため。
//  - 流入元で絞っても「流入元別の内訳」は絞らない（API が全候補を返す）。内訳は絞り込みの
//    候補一覧も兼ねるので、1 行に潰れると他の流入元へ切り替えられなくなるため。
//  - 数値は「総訪問(のべ)」と「一意訪問者」を必ず注記付きで並記する。注記なしに並べると
//    どちらが人数なのか読み違えるため（プロダクトデザイナー観点の必須対応）。
import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Card,
  DataTable,
  DatePicker,
  EmptyState,
  ErrorState,
  LoadMore,
  FormField,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonLoader,
  Stack,
  type ColumnDef,
} from "@dub/ui";
import { useLpApi } from "./LpProvider.tsx";
import type { LpSiteTraffic, LpStatsBucket, LpVisit } from "./lpApi.tsx";
import {
  LP_DEFAULT_RANGE_DAYS,
  LP_MAX_RANGE_DAYS,
  LP_RANGE_DAYS,
  addDays,
  countryLabel,
  customRangeError,
  deviceLabel,
  formatCount,
  formatDayLabel,
  formatRangeLabel,
  formatVisitTime,
  rangeDayCount,
  rangeForDays,
  rangeLabel,
  sourceLabel,
  toDayKey,
  type LpRangeDays,
} from "./lpRange.ts";
import { LpTabs } from "./LpTabs.tsx";
import { SourceBars } from "./SourceBars.tsx";
import { TrafficLineChart } from "./TrafficLineChart.tsx";
import styles from "./lp.module.css";

/** 1 ページの生ログ件数。大きくしすぎると初回描画が重くなるので控えめに。 */
const VISITS_PAGE_SIZE = 25;
/** 同じ期間を見ている間は再取得しない（無料枠の読み取り削減）。 */
const STALE_MS = 5 * 60 * 1000;
/** 流入元の絞り込み「すべて」。Select は null を返せないので空文字で表す。 */
const ALL = "";
const CUSTOM = "custom";

type DayRange = { from: string; to: string };
type RangeMode = LpRangeDays | typeof CUSTOM;

/** 流入元の Select。候補はレスポンスから作るので、読み込み中も直前の候補を出し続ける
 *  （選んだ直後に Select が消えて操作が途切れないように）。選択中の値が候補に無い時
 *  （期間を変えてその流入元が 0 件になった等）も選択肢に残す。 */
function SourceSelect({
  id,
  testId,
  value,
  onChange,
  buckets,
  labelOf,
}: {
  id: string;
  testId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  buckets: { key: string; label: string }[] | undefined;
  labelOf: (value: string) => string;
}): JSX.Element {
  const last = useRef<{ key: string; label: string }[]>([]);
  if (buckets) last.current = buckets;
  const options = [{ value: ALL, label: "すべての流入元" }, ...last.current.map((b) => ({ value: b.key, label: b.label }))];
  if (value !== null && !options.some((o) => o.value === value)) options.push({ value, label: labelOf(value) });
  return (
    <div className={styles.filterField}>
      <FormField label="流入元で絞り込み" htmlFor={id}>
        <Select<string>
          id={id}
          testId={testId}
          value={value ?? ALL}
          options={options}
          onChange={(v) => onChange(v === ALL ? null : v)}
        />
      </FormField>
    </div>
  );
}

/** bySource の label（発行時の名前）を優先。無ければ既定の表示名。 */
function sourceNameOf(buckets: LpStatsBucket[], key: string): string {
  return buckets.find((b) => b.key === key)?.label ?? sourceLabel(key);
}

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

type SiteDay = LpSiteTraffic["byDay"][number];

const SITE_DAY_COLUMNS: ColumnDef<SiteDay>[] = [
  { key: "date", header: "日付", cell: (r) => formatDayLabel(r.date), width: "8rem", noWrap: true },
  {
    key: "pageViews",
    header: "PV",
    align: "right",
    width: "8rem",
    cell: (r) => <span className={styles.num}>{formatCount(r.pageViews)}</span>,
  },
  {
    key: "visits",
    header: "訪問",
    align: "right",
    width: "8rem",
    cell: (r) => <span className={styles.num}>{formatCount(r.visits)}</span>,
  },
];

/** サイト全体のアクセス（Cloudflare Web Analytics）。流入URLの計測とは独立に読み込み・失敗する
 *  ので、片方が空/失敗でももう片方は見える。 */
function SiteTrafficCard({ range }: { range: DayRange }): JSX.Element {
  const api = useLpApi();
  const [referrer, setReferrer] = useState<string | null>(null);
  const site = useQuery({
    queryKey: ["lp", "site-traffic", range.from, range.to, referrer] as const,
    queryFn: () => api.getSiteTraffic(referrer ? { ...range, referrer } : range),
    staleTime: STALE_MS,
  });
  // byReferrer の key は代表ホストなので、絞り込みは label（ホストを束ねた単位）で行う。
  const referrerOptions = useMemo(
    () => site.data?.byReferrer.map((r) => ({ key: r.label, label: r.label })),
    [site.data],
  );
  const byDay = useMemo(() => (site.data?.byDay ?? []).slice().reverse(), [site.data]);

  let content: JSX.Element;
  if (site.isLoading) {
    content = (
      <Stack gap={5} testId="fe2-lp-site-loading">
        <div className={styles.kpiGrid}>
          {[0, 1].map((i) => (
            <Card key={i}>
              <SkeletonLoader lines={2} />
            </Card>
          ))}
        </div>
        <SkeletonLoader lines={5} />
      </Stack>
    );
  } else if (site.isError) {
    content = (
      <ErrorState
        testId="fe2-lp-site-error"
        error={{ code: "INTERNAL", message: "サイト全体のアクセスを読み込めませんでした。" }}
        onRetry={() => void site.refetch()}
      />
    );
  } else if (!site.data?.configured) {
    content = (
      <span className={styles.note} data-testid="fe2-lp-site-unconfigured">
        この環境では Cloudflare の計測が未設定のため表示できません。
      </span>
    );
  } else {
    const data = site.data;
    const only = referrer ? `「${referrer}」から来た分だけ。` : "";
    content = (
      <Stack gap={6} testId="fe2-lp-site-body">
        <div className={styles.kpiGrid}>
          <KpiCard
            testId="fe2-lp-site-kpi-pv"
            label="ページビュー(PV)"
            value={data.totals.pageViews}
            hint={`${only}ページが開かれた回数。再読み込みやサイト内の移動も数える`}
          />
          <KpiCard
            testId="fe2-lp-site-kpi-visits"
            label="訪問"
            value={data.totals.visits}
            hint={`${only}サイトの外から来て開いた回数(サイト内の移動は数えない)`}
          />
        </div>
        <Stack gap={4}>
          <span className={styles.sectionTitle}>アクセス数の推移</span>
          {data.byDay.length > 0 ? (
            <TrafficLineChart points={data.byDay} />
          ) : (
            <span className={styles.note}>この期間のアクセスはありません。</span>
          )}
        </Stack>
        <Stack gap={4}>
          <span className={styles.sectionTitle}>どこから来たか(流入元)</span>
          {data.byReferrer.length > 0 ? (
            <SourceBars
              testId="fe2-lp-site-referrers"
              rowTestId="fe2-lp-site-referrer"
              unit="PV"
              buckets={data.byReferrer.map((r) => ({ key: r.key, label: r.label, visits: r.pageViews, uniques: r.visits }))}
            />
          ) : (
            <span className={styles.note}>この期間のアクセスはありません。</span>
          )}
        </Stack>
        <Stack gap={4}>
          <span className={styles.sectionTitle}>日別</span>
          <DataTable<SiteDay>
            testId="fe2-lp-site-byday"
            columns={SITE_DAY_COLUMNS}
            rows={byDay}
            rowKey={(r) => r.date}
            emptyState={<EmptyState title="この期間の日別データがありません" icon="megaphone" />}
          />
        </Stack>
        <span className={styles.note}>
          Cloudflare Web Analytics の値です。Cloudflare 側の推定値のため、日が経つと数字が少し丸められることがあります。
          {referrer ? "流入元で絞った数字は流入元別の推定値から出すため、全体の数字と合計が少しずれることがあります。" : ""}
        </span>
      </Stack>
    );
  }

  return (
    <Card
      testId="fe2-lp-site"
      header={<span className={styles.sectionTitle}>サイト全体のアクセス(LP を開いた全員)</span>}
    >
      <Stack gap={6}>
        {site.data?.configured === false ? null : (
          <SourceSelect
            id="fe2-lp-site-referrer"
            testId="fe2-lp-site-referrer-filter"
            value={referrer}
            onChange={setReferrer}
            buckets={referrerOptions}
            labelOf={(v) => v}
          />
        )}
        {content}
      </Stack>
    </Card>
  );
}

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
  const today = useMemo(() => toDayKey(new Date()), []);
  const [mode, setMode] = useState<RangeMode>(LP_DEFAULT_RANGE_DAYS);
  // 期間は操作した時だけ作り直す（毎レンダーで new Date() を評価しない = queryKey が安定）。
  // カレンダーで不正な期間を選んでいる間は、直前の有効な期間のまま表示を続ける。
  const [range, setRange] = useState<DayRange>(() => rangeForDays(LP_DEFAULT_RANGE_DAYS));
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>(range);
  const [source, setSource] = useState<string | null>(null);
  const draftError = mode === CUSTOM ? customRangeError(draft.from, draft.to, today) : null;
  const periodLabel = mode === CUSTOM ? formatRangeLabel(range, today) : rangeLabel(mode);
  // カレンダーで選べる範囲: 未来は不可・最長 LP_MAX_RANGE_DAYS 日。
  const fromMin = draft.to ? addDays(draft.to, -(LP_MAX_RANGE_DAYS - 1)) : undefined;
  const toLimit = draft.from ? addDays(draft.from, LP_MAX_RANGE_DAYS - 1) : today;
  const toMax = toLimit < today ? toLimit : today;

  const chooseMode = (v: string): void => {
    if (v === CUSTOM) {
      // 直前に見ていた期間をカレンダーの初期値にする（そこから微調整できる）。
      setDraft(range);
      setMode(CUSTOM);
      return;
    }
    const d = Number(v) as LpRangeDays;
    setMode(d);
    setRange(rangeForDays(d));
  };
  const changeDraft = (next: { from: string | null; to: string | null }): void => {
    setDraft(next);
    if (next.from && next.to && customRangeError(next.from, next.to, today) === null) {
      setRange({ from: next.from, to: next.to });
    }
  };

  const stats = useQuery({
    queryKey: ["lp", "stats", range.from, range.to, source] as const,
    queryFn: () => api.getStats({ ...range, includeBots: false, ...(source ? { source } : {}) }),
    staleTime: STALE_MS,
  });

  const visits = useInfiniteQuery({
    queryKey: ["lp", "visits", range.from, range.to, source] as const,
    queryFn: ({ pageParam }) =>
      api.listVisits({
        from: range.from,
        to: range.to,
        limit: VISITS_PAGE_SIZE,
        ...(source ? { source } : {}),
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
      description="LP(ランディングページ)へのアクセスを見ます。上はサイト全体のアクセス、下は発行した流入URLごとの計測です。"
    />
  );

  const rangePicker = (
    <Stack gap={4}>
      <SegmentedControl<string>
        testId="fe2-lp-range"
        aria-label="集計期間"
        caption="集計期間"
        captionTestId="fe2-lp-range-caption"
        value={String(mode)}
        options={[
          ...LP_RANGE_DAYS.map((d) => ({ value: String(d), label: rangeLabel(d), testId: `fe2-lp-range-${d}` })),
          { value: CUSTOM, label: "期間を指定", testId: "fe2-lp-range-custom" },
        ]}
        onChange={chooseMode}
      />
      {mode === CUSTOM ? (
        <Stack gap={2} testId="fe2-lp-range-calendar">
          <Stack direction="row" gap={4} align="end" wrap>
            <div className={styles.filterField}>
              <FormField label="開始日" htmlFor="fe2-lp-range-from">
                <DatePicker
                  id="fe2-lp-range-from"
                  testId="fe2-lp-range-from"
                  value={draft.from}
                  min={fromMin}
                  max={draft.to ?? today}
                  invalid={draftError !== null}
                  onChange={(from) => changeDraft({ ...draft, from })}
                />
              </FormField>
            </div>
            <span className={styles.rangeDash} aria-hidden="true">
              〜
            </span>
            <div className={styles.filterField}>
              <FormField label="終了日" htmlFor="fe2-lp-range-to">
                <DatePicker
                  id="fe2-lp-range-to"
                  testId="fe2-lp-range-to"
                  value={draft.to}
                  min={draft.from ?? undefined}
                  max={toMax}
                  invalid={draftError !== null}
                  onChange={(to) => changeDraft({ ...draft, to })}
                />
              </FormField>
            </div>
          </Stack>
          {draftError ? (
            <span className={styles.rangeError} role="alert" data-testid="fe2-lp-range-error">
              {draftError}いまは {formatRangeLabel(range, today)} を表示しています。
            </span>
          ) : (
            <span className={styles.note} data-testid="fe2-lp-range-summary">
              {formatRangeLabel(range, today)}（{rangeDayCount(range.from, range.to)}日間）を表示中。最長
              {LP_MAX_RANGE_DAYS}日間まで選べます。
            </span>
          )}
        </Stack>
      ) : null}
    </Stack>
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
  } else if (source !== null && stats.data && stats.data.totals.visits === 0 && rows.length === 0) {
    body = (
      <EmptyState
        testId="fe2-lp-visits-empty-source"
        icon="megaphone"
        title="この流入元からの訪問はこの期間にありません"
        description="期間を広げるか、流入元の絞り込みを「すべての流入元」に戻してください。"
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
              {source ? "この内訳は絞り込みに関係なく、期間内のすべての流入元を表示しています。" : ""}
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
              {formatCount(rows.length)}件を表示中（{periodLabel}
              {source ? `・${sourceNameOf(stats.data.bySource, source)}のみ` : ""}・bot は除外）
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
      <SiteTrafficCard range={range} />
      <span className={styles.sectionTitle}>流入URLの計測</span>
      <SourceSelect
        id="fe2-lp-source"
        testId="fe2-lp-source-filter"
        value={source}
        onChange={setSource}
        buckets={stats.data?.bySource}
        labelOf={sourceLabel}
      />
      {body}
    </Stack>
  );
}
