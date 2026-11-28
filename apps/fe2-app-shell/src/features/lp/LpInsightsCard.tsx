// LP管理 → ログ管理「詳しい分析」(#904)。LP が cookie なしで集めた日次集計を読む read-only のカード。
// 推移 / 購入までの流れ / 流入元×申し込み完了 / ページ / セクション到達 / スクロール / ボタンのクリック /
// 端末・地域 / 表示速度。期間は画面上部の集計期間と共通。
//
// 設計メモ:
//  - 3 状態（スケルトン / 空 / 失敗+再試行）を作り込む（ほかのカードと同じ流儀）。
//  - 1 回の GET で全部返る（D1 は期間の範囲スキャン 1 本）。refetchInterval は付けない。
//  - 図は既存の部品（TrafficLineChart・横棒）だけ。チャートライブラリは足さない。
//  - 数字には必ず「何を数えたか」を添える（訪問 = タブ内のひと続きの閲覧、PV = ページを開いた回数）。
import { useQuery } from "@tanstack/react-query";
import { Card, DataTable, EmptyState, ErrorState, SkeletonLoader, Stack, type ColumnDef } from "@dub/ui";
import { lp, lpInsights } from "@dub/types";
import { useLpApi } from "./LpProvider.tsx";
import type { LpInsights } from "./lpApi.tsx";
import { barPercent, countryLabel, formatCount } from "./lpRange.ts";
import { SourceBars } from "./SourceBars.tsx";
import { TrafficLineChart } from "./TrafficLineChart.tsx";
import styles from "./lp.module.css";
import own from "./lpInsights.module.css";

const STALE_MS = 5 * 60 * 1000;

/** LP の section id（DOM）→ 表示名。公開設定の登録簿の名前に合わせる（join の DOM id は apply）。 */
const SECTION_LABELS: Record<string, string> = {
  top: "ファーストビュー",
  apply: lp.LP_SECTION_REGISTRY.join.label,
  header: "ヘッダー",
  footer: "フッター",
  float: "右下の購入ボタン",
  page: "その他の場所",
};
export function sectionLabel(id: string): string {
  if (SECTION_LABELS[id]) return SECTION_LABELS[id]!;
  const reg = (lp.LP_SECTION_REGISTRY as Record<string, { label: string } | undefined>)[id];
  return reg?.label ?? id;
}

/** 12345 → "12秒" / 83000 → "1分23秒"。 */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${String(s % 60).padStart(2, "0")}秒`;
}

const pct = (v: number): string => `${v.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}%`;

function Kpi({ testId, label, value, hint }: { testId: string; label: string; value: string; hint: string }): JSX.Element {
  return (
    <Card testId={testId}>
      <Stack gap={1}>
        <span className={styles.kpiLabel}>{label}</span>
        <span className={styles.kpiValue}>{value}</span>
        <span className={styles.kpiHint}>{hint}</span>
      </Stack>
    </Card>
  );
}

/** 率の横棒（0〜100%）。色だけに頼らず、右に数値をテキストで併記する。 */
function RateBars({ testId, rows }: { testId: string; rows: { key: string; label: string; pct: number; text: string }[] }): JSX.Element {
  return (
    <div className={styles.bars} data-testid={testId}>
      {rows.map((r) => (
        <div key={r.key} className={styles.barRow} data-testid={`${testId}-${r.key}`}>
          <span className={styles.barLabel}>{r.label}</span>
          <div className={styles.barTrack} role="img" aria-label={`${r.label} ${r.text}`}>
            <div className={styles.barFill} style={{ width: `${Math.min(100, Math.max(0, r.pct))}%` }} />
          </div>
          <span className={styles.barValue}>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, testId, note, children }: { title: string; testId: string; note?: string; children: JSX.Element }): JSX.Element {
  return (
    <Stack gap={4} testId={testId}>
      <span className={styles.sectionTitle}>{title}</span>
      {children}
      {note ? <span className={styles.note}>{note}</span> : null}
    </Stack>
  );
}

const asBuckets = (rows: lpInsights.LpInsightBucket[], label: (r: lpInsights.LpInsightBucket) => string = (r) => r.label) =>
  rows.map((r) => ({ key: r.key || "none", label: label(r), visits: r.sessions, uniques: r.sessions }));

function Bars({ testId, rows, empty }: { testId: string; rows: ReturnType<typeof asBuckets>; empty: string }): JSX.Element {
  return rows.length > 0 ? (
    <SourceBars testId={testId} rowTestId={`${testId}-row`} unit="訪問" buckets={rows} />
  ) : (
    <span className={styles.note}>{empty}</span>
  );
}

type SourceRow = lpInsights.LpInsightSourceBucket;
const SOURCE_COLUMNS: ColumnDef<SourceRow>[] = [
  { key: "label", header: "流入元", cell: (r) => r.label, minWidth: "10rem" },
  { key: "sessions", header: "訪問", align: "right", width: "6rem", cell: (r) => <span className={styles.num}>{formatCount(r.sessions)}</span> },
  { key: "views", header: "PV", align: "right", width: "6rem", cell: (r) => <span className={styles.num}>{formatCount(r.views)}</span> },
  { key: "avg", header: "平均表示時間", align: "right", width: "8rem", noWrap: true, cell: (r) => formatDuration(r.avgEngagedMs) },
  { key: "purchases", header: "申し込み完了", align: "right", width: "7rem", cell: (r) => <span className={styles.num}>{formatCount(r.purchases)}</span> },
  { key: "rate", header: "完了率", align: "right", width: "6rem", noWrap: true, cell: (r) => pct(r.purchaseRatePct) },
];

type PageRow = lpInsights.LpInsightBucket;
const PAGE_COLUMNS: ColumnDef<PageRow>[] = [
  { key: "key", header: "ページ", cell: (r) => <code className={own.path}>{r.key}</code>, minWidth: "10rem" },
  { key: "views", header: "PV", align: "right", width: "6rem", cell: (r) => <span className={styles.num}>{formatCount(r.views)}</span> },
  { key: "sessions", header: "入口になった訪問", align: "right", width: "9rem", cell: (r) => <span className={styles.num}>{formatCount(r.sessions)}</span> },
  { key: "avg", header: "平均表示時間", align: "right", width: "8rem", noWrap: true, cell: (r) => formatDuration(r.avgEngagedMs) },
];

type CtaRow = lpInsights.LpInsightCta;
const CTA_COLUMNS: ColumnDef<CtaRow>[] = [
  {
    key: "kind",
    header: "押されたリンク",
    minWidth: "11rem",
    cell: (r) => `${lpInsights.LP_CTA_KIND_LABELS[r.kind] ?? r.kind}${r.target ? `（${r.target}）` : ""}`,
  },
  { key: "section", header: "場所", width: "10rem", cell: (r) => sectionLabel(r.section) },
  { key: "clicks", header: "クリック", align: "right", width: "6rem", cell: (r) => <span className={styles.num}>{formatCount(r.clicks)}</span> },
  { key: "rate", header: "クリック率", align: "right", width: "7rem", noWrap: true, cell: (r) => pct(r.ratePct) },
];

type VitalRow = lpInsights.LpInsightVital;
const VITAL_COLUMNS: ColumnDef<VitalRow>[] = [
  { key: "metric", header: "指標", minWidth: "11rem", cell: (r) => lpInsights.LP_VITAL_LABELS[r.metric] },
  {
    key: "avg",
    header: "平均",
    align: "right",
    width: "6rem",
    noWrap: true,
    cell: (r) => (r.avg === null ? "—" : r.metric === "cls" ? r.avg.toFixed(2) : `${(r.avg / 1000).toFixed(2)}秒`),
  },
  { key: "good", header: "良好", align: "right", width: "5rem", cell: (r) => <span className={styles.num}>{formatCount(r.good)}</span> },
  { key: "ni", header: "要改善", align: "right", width: "5rem", cell: (r) => <span className={styles.num}>{formatCount(r.ni)}</span> },
  { key: "poor", header: "不良", align: "right", width: "5rem", cell: (r) => <span className={styles.num}>{formatCount(r.poor)}</span> },
];

function InsightsBody({ data }: { data: LpInsights }): JSX.Element {
  const t = data.totals;
  const funnelMax = data.funnel[0]?.sessions ?? 0;
  return (
    <Stack gap={8} testId="fe2-lp-ins-body">
      <div className={styles.kpiGrid}>
        <Kpi testId="fe2-lp-ins-kpi-sessions" label="訪問" value={formatCount(t.sessions)} hint="同じタブでひと続きに見た分を 1 訪問（30 分あくと次の訪問）" />
        <Kpi testId="fe2-lp-ins-kpi-views" label="ページビュー(PV)" value={formatCount(t.views)} hint={`1 訪問あたり ${t.pagesPerSession} ページ`} />
        <Kpi testId="fe2-lp-ins-kpi-time" label="平均滞在" value={formatDuration(t.avgSessionMs)} hint="1 訪問でページを表示していた時間の平均" />
        <Kpi testId="fe2-lp-ins-kpi-purchases" label="申し込み完了" value={formatCount(t.purchases)} hint="チケットの申し込み完了ページまで進んだ訪問" />
      </div>

      <Section title="訪問と PV の推移" testId="fe2-lp-ins-trend">
        <TrafficLineChart testId="fe2-lp-ins-chart" points={data.byDay.map((d) => ({ date: d.date, pageViews: d.views, visits: d.sessions }))} />
      </Section>

      <Section
        title="チケット購入までの流れ"
        testId="fe2-lp-ins-funnel"
        note="訪問ごとに 1 回だけ数えます。%は「LP を訪問」に対する割合、カッコ内は 1 つ前の段階からの通過率です。"
      >
        <RateBars
          testId="fe2-lp-ins-funnel-bars"
          rows={data.funnel.map((f) => ({
            key: f.step,
            label: lpInsights.LP_STEP_LABELS[f.step],
            pct: barPercent(f.sessions, funnelMax),
            text: f.step === "visit" ? `${formatCount(f.sessions)}訪問` : `${formatCount(f.sessions)}訪問 ${pct(f.fromVisitPct)}（${pct(f.fromPrevPct)}）`,
          }))}
        />
      </Section>

      <Section title="流入元ごとの成果" testId="fe2-lp-ins-sources" note="流入元は訪問の入口についていた utm_source（無ければ直接アクセス）。">
        <DataTable<SourceRow>
          testId="fe2-lp-ins-sources-table"
          columns={SOURCE_COLUMNS}
          rows={data.sources}
          rowKey={(r) => r.key}
          emptyState={<EmptyState title="この期間の流入元はありません" icon="megaphone" />}
        />
      </Section>

      <div className={own.grid}>
        <Section title="キャンペーン (utm_campaign)" testId="fe2-lp-ins-campaigns">
          <Bars testId="fe2-lp-ins-campaign-bars" rows={asBuckets(data.campaigns)} empty="utm_campaign 付きの訪問はありません。" />
        </Section>
        <Section title="媒体 (utm_medium)" testId="fe2-lp-ins-mediums">
          <Bars testId="fe2-lp-ins-medium-bars" rows={asBuckets(data.mediums)} empty="utm_medium 付きの訪問はありません。" />
        </Section>
        <Section title="リンク元のサイト" testId="fe2-lp-ins-referrers">
          <Bars testId="fe2-lp-ins-referrer-bars" rows={asBuckets(data.referrers)} empty="この期間の訪問はありません。" />
        </Section>
      </div>

      <Section title="よく見られたページ" testId="fe2-lp-ins-pages">
        <DataTable<PageRow>
          testId="fe2-lp-ins-pages-table"
          columns={PAGE_COLUMNS}
          rows={data.pages}
          rowKey={(r) => r.key}
          emptyState={<EmptyState title="この期間のページビューはありません" icon="megaphone" />}
        />
      </Section>

      <div className={own.grid}>
        <Section title="セクションの到達率" testId="fe2-lp-ins-sections" note="トップページを開いた回数のうち、そのセクションが画面の半分以上に映った割合。">
          <RateBars
            testId="fe2-lp-ins-section-bars"
            rows={data.sections.map((s) => ({ key: s.key, label: sectionLabel(s.key), pct: s.reachPct, text: pct(s.reachPct) }))}
          />
        </Section>
        <Section title="スクロールの深さ" testId="fe2-lp-ins-scroll" note="ページを開いた回数のうち、その深さまで読み進めた割合。">
          <RateBars
            testId="fe2-lp-ins-scroll-bars"
            rows={data.scroll.map((s) => ({ key: s.key, label: `${s.key}%まで`, pct: s.reachPct, text: pct(s.reachPct) }))}
          />
        </Section>
      </div>

      <Section title="ボタン・リンクのクリック" testId="fe2-lp-ins-ctas" note="クリック率 = そのセクションが映った回数のうち押された割合。">
        <DataTable<CtaRow>
          testId="fe2-lp-ins-ctas-table"
          columns={CTA_COLUMNS}
          rows={data.ctas}
          rowKey={(r) => r.key}
          emptyState={<EmptyState title="この期間のクリックはありません" icon="megaphone" />}
        />
      </Section>

      <div className={own.grid}>
        <Section title="端末" testId="fe2-lp-ins-devices">
          <Bars testId="fe2-lp-ins-device-bars" rows={asBuckets(data.devices)} empty="データがありません。" />
        </Section>
        <Section title="OS" testId="fe2-lp-ins-os">
          <Bars testId="fe2-lp-ins-os-bars" rows={asBuckets(data.os)} empty="データがありません。" />
        </Section>
        <Section title="ブラウザ" testId="fe2-lp-ins-browsers">
          <Bars testId="fe2-lp-ins-browser-bars" rows={asBuckets(data.browsers)} empty="データがありません。" />
        </Section>
        <Section title="地域（都道府県）" testId="fe2-lp-ins-regions">
          <Bars testId="fe2-lp-ins-region-bars" rows={asBuckets(data.regions)} empty="データがありません。" />
        </Section>
        <Section title="国" testId="fe2-lp-ins-countries">
          <Bars testId="fe2-lp-ins-country-bars" rows={asBuckets(data.countries, (r) => countryLabel(r.key))} empty="データがありません。" />
        </Section>
      </div>

      <Section
        title="表示の速さ（Core Web Vitals）"
        testId="fe2-lp-ins-vitals"
        note="訪問の入口ページで、対応ブラウザ（主に Chrome 系）から計測。良好の目安: LCP 2.5 秒以下・INP 0.2 秒以下・CLS 0.1 以下。"
      >
        <DataTable<VitalRow> testId="fe2-lp-ins-vitals-table" columns={VITAL_COLUMNS} rows={data.vitals} rowKey={(r) => r.metric} />
      </Section>
    </Stack>
  );
}

export function LpInsightsCard({ range }: { range: { from: string; to: string } }): JSX.Element {
  const api = useLpApi();
  const q = useQuery({
    queryKey: ["lp", "insights", range.from, range.to] as const,
    queryFn: () => api.getInsights(range),
    staleTime: STALE_MS,
  });

  let content: JSX.Element;
  if (q.isLoading) {
    content = (
      <Stack gap={6} testId="fe2-lp-ins-loading">
        <div className={styles.kpiGrid}>
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <SkeletonLoader lines={2} />
            </Card>
          ))}
        </div>
        <SkeletonLoader lines={6} />
        <SkeletonLoader lines={4} />
      </Stack>
    );
  } else if (q.isError || !q.data) {
    content = (
      <ErrorState
        testId="fe2-lp-ins-error"
        error={{ code: "INTERNAL", message: "詳しい分析を読み込めませんでした。" }}
        onRetry={() => void q.refetch()}
      />
    );
  } else if (q.data.totals.views === 0) {
    content = (
      <EmptyState
        testId="fe2-lp-ins-empty"
        icon="megaphone"
        title="この期間の分析データはまだありません"
        description="LP を開いた人がページを離れたときに記録されます。期間を広げると過去の分が見えることがあります。"
      />
    );
  } else {
    content = <InsightsBody data={q.data} />;
  }

  return (
    <Card testId="fe2-lp-ins" header={<span className={styles.sectionTitle}>詳しい分析（来訪者の操作なしで集める計測）</span>}>
      <Stack gap={6}>
        {content}
        <span className={styles.note}>
          cookie や同意の操作は使わず、1 人ごとの記録も残しません（日ごとの件数だけを保存）。ブラウザで「トラッキング拒否」を有効にしている人は数えません。
        </span>
      </Stack>
    </Card>
  );
}
