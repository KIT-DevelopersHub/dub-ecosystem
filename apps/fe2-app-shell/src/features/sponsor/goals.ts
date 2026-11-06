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

/** 接触済なのに初回連絡日が無い企業 = どの月の実績にも入らない企業 (スプレッドシートから移した過去分など)。 */
export function undatedLeads(leads: readonly Lead[]): number {
  return leads.filter((l) => l.status !== "未接触" && l.firstContactOn === null).length;
}

/** 達成率 (%)。目標なしは null。 */
export const achievement = (actual: number, target: number | null): number | null =>
  target === null ? null : Math.round((actual / target) * 100);

export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return currentMonth(new Date(y, m - 1 + by, 1));
}

/** 2026-11 → 2026年11月 */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}

export const formatMetric = (value: number, unit: "社" | "円"): string =>
  unit === "円" ? `¥${value.toLocaleString("ja-JP")}` : `${value} 社`;
