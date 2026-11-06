// 月間目標の純関数: 営業進捗の日付から月の実績を数え、達成率を出す。実績は保存しない (一覧が正)。
import { sponsor } from "@dub/types";

type Lead = sponsor.SponsorLead;
export type Actuals = Record<sponsor.GoalMetric, number>;

export const METRICS: readonly { key: sponsor.GoalMetric; label: string; unit: "社" | "円"; definition: string }[] = [
  { key: "contacted", label: "新規接触", unit: "社", definition: "初回連絡日がその月の企業" },
  { key: "proposed", label: "提案", unit: "社", definition: "提案日がその月の企業" },
  { key: "agreed", label: "内諾・契約", unit: "社", definition: "内諾日がその月の企業（見送りを除く）" },
  { key: "amount", label: "協賛額", unit: "円", definition: "その月に内諾した企業の想定協賛額の合計（見送りを除く）" },
];

const inMonth = (on: string | null, month: string): boolean => on?.startsWith(`${month}-`) ?? false;

export function monthActuals(leads: readonly Lead[], month: string): Actuals {
  const agreed = leads.filter((l) => inMonth(l.agreedOn, month) && l.status !== "見送り");
  return {
    contacted: leads.filter((l) => inMonth(l.firstContactOn, month)).length,
    proposed: leads.filter((l) => inMonth(l.proposedOn, month)).length,
    agreed: agreed.length,
    amount: agreed.reduce((sum, l) => sum + (l.expectedAmount ?? 0), 0),
  };
}

/** 達した節目の日付が空の企業 = 実績に入らない分がある企業 (スプレッドシートから移した過去分など)。見送りは節目が分からないので除く。 */
export function undatedLeads(leads: readonly Lead[]): number {
  return leads.filter((l) =>
    sponsor.LEAD_MILESTONES.some((m) => sponsor.leadStatusRank(l.status) >= sponsor.leadStatusRank(m.reachedAt) && l[m.field] === null),
  ).length;
}

/** 達成率 (%)。100% は達成した時だけ見せるので切り捨てる。目標なしは null。 */
export const achievement = (actual: number, target: number | null): number | null =>
  target === null ? null : Math.floor((actual / target) * 100);

/** 今月 (日本時間)。節目の日付と同じ暦で数える。 */
export const currentMonth = (now: Date = new Date()): string => sponsor.jstDate(now.toISOString()).slice(0, 7);

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** 2026-11 → 2026年11月 */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}

export const formatMetric = (value: number, unit: "社" | "円"): string =>
  unit === "円" ? `¥${value.toLocaleString("ja-JP")}` : `${value} 社`;
