// 目標管理: チームごとの 1 か月の目標と KPI (member-service /members/goals)。
// 実績は保存せず、表示のたびに各アプリのデータから数える。指標の定義と達成率の計算はここが SoT。
import type { ISODateTime, TeamId, UserId } from "./common";
import type { GoalMetric as SponsorMetric, MonthlyGoal as SponsorMonthlyGoal } from "./sponsor";

export const GOAL_TITLE_MAX = 200;
export const KPI_NAME_MAX = 100;
export const KPI_MAX = 10;
export const KPI_VALUE_MAX = 1_000_000_000;

/** team = そのチームの分だけ数える / org = 団体全体で 1 つの数字 (どのチームが選んでも同じ値)。 */
export type MetricScope = "team" | "org";

export const GOAL_METRICS = [
  { key: "tasks_done", label: "タスク完了数", unit: "件", scope: "team", source: "タスク", definition: "このチームの、期限がその月のタスクのうち完了した数" },
  { key: "tasks_done_rate", label: "タスク完了率", unit: "%", scope: "team", source: "タスク", definition: "このチームの、期限がその月のタスクのうち完了した割合（中止を除く）" },
  { key: "hr_applicants", label: "応募者数", unit: "人", scope: "org", source: "人事", definition: "その月に登録された応募者の数（全体）" },
  { key: "hr_interviews", label: "面談数", unit: "人", scope: "org", source: "人事", definition: "面談日がその月の応募者の数（全体）" },
  { key: "hr_hired", label: "採用数", unit: "人", scope: "org", source: "人事", definition: "その月に採用へ進めた応募者の数（全体）" },
  { key: "sponsor_cards", label: "名刺の登録数", unit: "枚", scope: "org", source: "スポンサー", definition: "その月に登録された名刺の数（全体）" },
  { key: "sponsor_contacted", label: "新規接触数", unit: "社", scope: "org", source: "スポンサー", definition: "初回連絡日がその月の企業の数（全体）" },
  { key: "sponsor_proposed", label: "提案数", unit: "社", scope: "org", source: "スポンサー", definition: "提案日がその月の企業の数（全体）" },
  { key: "sponsor_agreed", label: "内諾・契約数", unit: "社", scope: "org", source: "スポンサー", definition: "内諾日がその月の企業の数（見送りを除く・全体）" },
  { key: "sponsor_amount", label: "協賛額", unit: "円", scope: "org", source: "スポンサー", definition: "その月に内諾した企業の想定協賛額の合計（見送りを除く・全体）" },
  { key: "participations", label: "参加届の提出数", unit: "件", scope: "org", source: "参加届", definition: "その月に提出された参加届の数（全体）" },
  { key: "lp_visitors", label: "LP の訪問者数", unit: "人", scope: "org", source: "LP管理", definition: "その月に LP を訪れた人の数（bot を除く）" },
  { key: "manual", label: "手入力", unit: "", scope: "team", source: "手入力", definition: "Dub で数えられない数字を、実績欄に手で入れる" },
] as const satisfies readonly { key: string; label: string; unit: string; scope: MetricScope; source: string; definition: string }[];

export type GoalMetric = (typeof GOAL_METRICS)[number]["key"];

export const metricOf = (key: GoalMetric): (typeof GOAL_METRICS)[number] => GOAL_METRICS.find((m) => m.key === key)!;
export const isGoalMetric = (v: unknown): v is GoalMetric => GOAL_METRICS.some((m) => m.key === v);

/** スポンサーアプリの「目標」タブに出す指標。目標値はここ (KPI) が正で、タブは表示するだけ。 */
const SPONSOR_TAB_METRICS: Partial<Record<GoalMetric, SponsorMetric>> = {
  sponsor_contacted: "contacted",
  sponsor_proposed: "proposed",
  sponsor_agreed: "agreed",
  sponsor_amount: "amount",
};

export const isSponsorTabMetric = (metric: GoalMetric): boolean => metric in SPONSOR_TAB_METRICS;

/** 全チームの KPI からタブの月間目標を作る (新しい月が先頭)。実績は団体全体で 1 つなので、複数チームが置いた指標は足さず大きい方を出す。 */
export function sponsorGoalsOf(goals: readonly { month: string; kpis: readonly Pick<Kpi, "metric" | "target">[] }[]): SponsorMonthlyGoal[] {
  const months = new Map<string, SponsorMonthlyGoal>();
  for (const { month, kpis } of goals) {
    for (const { metric, target } of kpis) {
      const key = SPONSOR_TAB_METRICS[metric];
      if (!key) continue;
      const row = months.get(month) ?? { month, contacted: null, proposed: null, agreed: null, amount: null };
      months.set(month, { ...row, [key]: Math.max(row[key] ?? 0, target) });
    }
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** 保存する KPI。manualActual は metric = manual のときだけ意味を持つ。 */
export interface Kpi {
  name: string;
  metric: GoalMetric;
  target: number;
  manualActual: number;
}

/** ok = 集計できた / empty = 対象が無い (期限のタスク 0 件の完了率) / unavailable = 取得に失敗した。 */
export type KpiStatus = "ok" | "empty" | "unavailable";

export interface KpiProgress extends Kpi {
  status: KpiStatus;
  actual: number | null;
  /** 達成率 (%)。100 を超えることもある。集計できなければ null。 */
  percent: number | null;
}

export interface TeamGoal {
  teamId: TeamId;
  /** YYYY-MM (日本時間の暦月)。 */
  month: string;
  title: string;
  kpis: KpiProgress[];
  /** チームの進捗 (%)。KPI ごとの達成率を 100 で頭打ちにした平均。数えられる KPI が無ければ null。 */
  percent: number | null;
  version: number;
  updatedBy: UserId;
  updatedByName: string | null;
  updatedAt: ISODateTime;
}

export interface GoalTeam {
  id: TeamId;
  name: string;
  color: string | null;
}

export interface ListGoalsResponse {
  month: string;
  teams: GoalTeam[];
  goals: TeamGoal[];
}

export interface PutGoalRequest {
  title: string;
  kpis: Kpi[];
  /** 新規は 0。 */
  expectedVersion: number;
}

/** 達成率 (%)。切り捨て: 未達を四捨五入で 100% に見せない。実績が無ければ null。 */
export const kpiPercent = (actual: number | null, target: number): number | null =>
  actual === null ? null : Math.floor((actual * 100) / target);

/** チームの進捗。超過分で他の未達を隠さないよう、KPI ごとに 100 で頭打ちにして平均する。 */
export function goalPercent(kpis: readonly Pick<KpiProgress, "percent">[]): number | null {
  const values = kpis.flatMap((k) => (k.percent === null ? [] : [Math.min(k.percent, 100)]));
  return values.length === 0 ? null : Math.floor(values.reduce((sum, p) => sum + p, 0) / values.length);
}

/** 達成 = 全 KPI を数えられて、すべて目標に届いた。集計できない KPI があるうちは達成と言わない。 */
export const isAchieved = (g: Pick<TeamGoal, "kpis" | "percent">): boolean =>
  g.percent === 100 && g.kpis.every((k) => k.status === "ok");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (v: unknown): v is string => typeof v === "string" && MONTH_RE.test(v);

const JST_OFFSET_MS = 9 * 3_600_000;

/** 日本時間の今月 (YYYY-MM)。 */
export const currentMonth = (now: Date = new Date()): string => new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 7);

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** 2026-11 → 2026年11月 */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** その月の経過日数 (日本時間・今日を含む)。過去の月は全日数、先の月は 0。 */
export function elapsedDays(month: string, now: Date = new Date()): number {
  const today = new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
  const nowMonth = today.slice(0, 7);
  if (month < nowMonth) return daysInMonth(month);
  return month > nowMonth ? 0 : Number(today.slice(8));
}

/** 指標の値の表示 (例: 12件 / 80%)。 */
export const formatValue = (value: number, metric: GoalMetric): string => `${value.toLocaleString("ja-JP")}${metricOf(metric).unit}`;
