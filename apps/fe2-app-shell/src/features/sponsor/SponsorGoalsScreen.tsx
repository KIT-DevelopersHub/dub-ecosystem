// スポンサー → 目標。目標管理アプリのスポンサー KPI の目標値と実績・達成率を見る (閲覧専用)。
// 出す指標は KPI に置かれたものだけ: 目標管理で KPI を足す・消すと、カードと推移の列も増える・減る。
// 上 = 選んだ月のカード (実績 / 目標・達成率・メーター)、下 = 直近 6 か月の推移。
import { useMemo, useState } from "react";
import { Badge, Button, DataTable, EmptyState, ErrorState, Skeleton, SkeletonTable, Stack, type ColumnDef } from "@dub/ui";
import { goal } from "@dub/types";
import { useAppCapability } from "../../auth/AuthProvider.tsx";
import { useGoals, useLeads } from "./leadHooks.ts";
import { undatedLeads } from "./goals.ts";
import { SponsorFrame } from "./SponsorCardsScreen.tsx";
import styles from "./sponsor.module.css";

const HISTORY_MONTHS = 6;

type Metric = goal.SponsorTabMetric;

function GoalCard({ m }: { m: Metric & { target: number } }): JSX.Element {
  const def = goal.metricOf(m.metric);
  const remaining = m.actual === null ? 0 : m.target - m.actual;
  return (
    <div className={styles.goalCard} data-testid={`fe2-sponsor-goal-${m.metric}`}>
      <div className={styles.goalHead}>
        <span className={styles.goalLabel}>{def.label}</span>
        {m.actual !== null && m.actual >= m.target ? <Badge tone="success">達成</Badge> : null}
      </div>
      <div className={styles.goalNumbers}>
        <span className={styles.goalActual} data-testid={`fe2-sponsor-goal-actual-${m.metric}`}>
          {m.actual === null ? "—" : goal.formatValue(m.actual, m.metric)}
        </span>
        <span className={styles.goalTarget}>/ {goal.formatValue(m.target, m.metric)}</span>
      </div>
      {m.percent !== null ? (
        <>
          <div
            className={styles.meter}
            role="progressbar"
            aria-label={`${def.label}の達成率`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(m.percent, 100)}
          >
            <div className={styles.meterFill} style={{ width: `${Math.min(m.percent, 100)}%` }} />
          </div>
          <div className={styles.goalFoot}>
            <span className={styles.goalRate} data-testid={`fe2-sponsor-goal-rate-${m.metric}`}>
              {m.percent}%
            </span>
            <span className={styles.note}>{remaining > 0 ? `あと ${goal.formatValue(remaining, m.metric)}` : "目標に到達"}</span>
          </div>
        </>
      ) : (
        <p className={styles.note}>集計できませんでした</p>
      )}
    </div>
  );
}

interface HistoryRow {
  month: string;
  selected: boolean;
  metrics: Metric[];
}

function historyCell(row: HistoryRow, metric: goal.GoalMetric): string {
  const m = row.metrics.find((x) => x.metric === metric);
  if (!m || m.actual === null) return "—";
  const actual = goal.formatValue(m.actual, metric);
  return m.percent === null ? actual : `${actual}（${m.percent}%）`;
}

function historyColumns(metrics: readonly goal.GoalMetric[]): ColumnDef<HistoryRow>[] {
  return [
    {
      key: "month",
      header: "月",
      noWrap: true,
      cell: (r) => (
        <span className={styles.leadNext}>
          <span className={styles.rowName} data-testid={`fe2-sponsor-goal-month-${r.month}`}>
            {goal.monthLabel(r.month)}
          </span>
          {r.selected ? <Badge tone="info">表示中</Badge> : null}
        </span>
      ),
    },
    ...metrics.map((key) => ({ key, header: goal.metricOf(key).label, noWrap: true, cell: (r: HistoryRow) => historyCell(r, key) })),
  ];
}

const hasTarget = (m: Metric): m is Metric & { target: number } => m.target !== null;

export function SponsorGoalsScreen(): JSX.Element {
  const leads = useLeads();
  const thisMonth = goal.currentMonth();
  const historyFrom = goal.shiftMonth(thisMonth, -(HISTORY_MONTHS - 1));
  // 推移は今月で固定 (行を押しても表が動かない)。その外の月を選んだ時だけ、その月を別に取る。
  const history = useGoals(historyFrom, thisMonth);
  const [month, setMonth] = useState(thisMonth);
  const inHistory = month >= historyFrom && month <= thisMonth;
  const picked = useGoals(month, month, !inHistory);
  const { canView: canViewGoalsApp } = useAppCapability("goals");

  const historyMonths = history.data?.months;
  const selected = (inHistory ? historyMonths : picked.data?.months)?.find((m) => m.month === month);
  const cards = selected?.metrics.filter(hasTarget) ?? [];
  // 列 = 推移か選んだ月のどこかで KPI に置かれた指標。
  const columns = useMemo(() => {
    const used = new Set([...(historyMonths ?? []), ...(selected ? [selected] : [])].flatMap((m) => m.metrics.filter(hasTarget).map((x) => x.metric)));
    return historyColumns(goal.SPONSOR_TAB_METRICS.filter((k) => used.has(k)));
  }, [historyMonths, selected]);
  const rows: HistoryRow[] = (historyMonths ?? []).map((m) => ({ month: m.month, selected: m.month === month, metrics: m.metrics }));
  const undated = undatedLeads(leads.data?.leads ?? []);
  const loading = history.data === undefined || (!inHistory && picked.data === undefined);
  const failed = history.isError || (!inHistory && picked.isError);

  const setUpLink = canViewGoalsApp ? (
    <>
      目標は<a href="/goals">目標管理</a>アプリのチームの KPI で設定します。KPI を足すと、ここにも並びます。
    </>
  ) : (
    "目標は目標管理アプリで設定します。設定や変更は、目標管理アプリの権限を持つ人に依頼してください。"
  );

  let body: JSX.Element;
  if (failed) {
    body = (
      <ErrorState
        testId="fe2-sponsor-goals-error"
        error={{ code: "INTERNAL", message: "目標を読み込めませんでした。" }}
        onRetry={() => {
          void history.refetch();
          if (!inHistory) void picked.refetch();
        }}
      />
    );
  } else if (loading) {
    body = (
      <div className={styles.leadsLoading} data-testid="fe2-sponsor-goals-loading" aria-busy="true" aria-label="目標を読み込み中">
        <div className={styles.goalGrid}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} variant="rect" width="100%" height="9rem" />
          ))}
        </div>
        <SkeletonTable rows={HISTORY_MONTHS} columns={5} />
      </div>
    );
  } else {
    body = (
      <>
        {cards.length > 0 ? (
          <div className={styles.goalGrid}>
            {cards.map((m) => (
              <GoalCard key={m.metric} m={m} />
            ))}
          </div>
        ) : (
          <EmptyState testId="fe2-sponsor-goals-empty" icon="info" title="この月のスポンサーの KPI はありません" description="目標管理アプリでチームの KPI にスポンサーの指標を足すと、ここに表示されます。" />
        )}
        {columns.length > 1 ? (
          <Stack gap={3}>
            <h3 className={styles.leadSectionTitle}>直近 {HISTORY_MONTHS} か月の推移</h3>
            <DataTable<HistoryRow>
              testId="fe2-sponsor-goals-history"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.month}
              onRowClick={(r) => setMonth(r.month)}
            />
          </Stack>
        ) : null}
        <div className={styles.goalNotes}>
          <p className={styles.note} data-testid="fe2-sponsor-goals-link">
            {setUpLink}
          </p>
          {cards.length > 0 ? (
            <p className={styles.note}>{cards.map((m) => `${goal.metricOf(m.metric).label} = ${goal.metricOf(m.metric).definition}`).join("。")}。</p>
          ) : null}
          {undated > 0 ? (
            <p className={styles.note} data-testid="fe2-sponsor-goals-undated">
              初回連絡日・提案日・内諾日のいずれかが空の {undated} 社は、その分が月の実績に入っていません（「営業」タブの詳細から日付を入れると数えられます）。
            </p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <SponsorFrame active="goals" wide>
      <>
        <div className={styles.monthNav}>
          <Button variant="secondary" size="sm" testId="fe2-sponsor-goal-prev" onClick={() => setMonth(goal.shiftMonth(month, -1))}>
            前の月
          </Button>
          <span className={styles.monthLabel} data-testid="fe2-sponsor-goal-month" aria-live="polite">
            {goal.monthLabel(month)}
          </span>
          <Button variant="secondary" size="sm" testId="fe2-sponsor-goal-next" onClick={() => setMonth(goal.shiftMonth(month, 1))}>
            次の月
          </Button>
          {month !== thisMonth ? (
            <Button variant="ghost" size="sm" testId="fe2-sponsor-goal-today" onClick={() => setMonth(thisMonth)}>
              今月に戻る
            </Button>
          ) : null}
        </div>
        {body}
      </>
    </SponsorFrame>
  );
}
