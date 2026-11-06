// 営業進捗の純関数: 集計・並べ替え・次回アクションの期限・金額の表示。
import { sponsor } from "@dub/types";
import type { BadgeTone } from "@dub/ui";

type Lead = sponsor.SponsorLead;

/** ここより後ろのステータスを「提案済」に数える。 */
const PROPOSED = sponsor.LEAD_STATUSES.indexOf("提案済");
/** ここより後ろのステータスを「内諾・契約」に数える。 */
const AGREED = sponsor.LEAD_STATUSES.indexOf("内諾");

/** 進み具合 (見送りは最下位)。 */
export function statusRank(s: sponsor.LeadStatus): number {
  return s === "見送り" ? -1 : sponsor.LEAD_STATUSES.indexOf(s);
}

export interface LeadSummary {
  total: number;
  contacted: number;
  proposed: number;
  agreed: number;
}

/** スプレッドシートの「現在の営業状況」と同じ数え方 (接触済には見送りも含む)。 */
export function summarizeLeads(leads: readonly Pick<Lead, "status">[]): LeadSummary {
  return {
    total: leads.length,
    contacted: leads.filter((l) => l.status !== "未接触").length,
    proposed: leads.filter((l) => statusRank(l.status) >= PROPOSED).length,
    agreed: leads.filter((l) => statusRank(l.status) >= AGREED).length,
  };
}

export const STATUS_TONE: Record<sponsor.LeadStatus, BadgeTone> = {
  未接触: "neutral",
  初回連絡: "info",
  返信あり: "info",
  提案予定: "info",
  提案済: "info",
  社内検討: "warning",
  条件調整: "warning",
  内諾: "success",
  契約済: "success",
  見送り: "neutral",
};

/** 端末の暦で今日 (YYYY-MM-DD)。 */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 次回アクション日を過ぎている (契約済・見送りは対象外)。 */
export function isOverdue(lead: Pick<Lead, "status" | "nextActionOn">, today: string): boolean {
  if (lead.status === "契約済" || lead.status === "見送り") return false;
  return lead.nextActionOn !== null && lead.nextActionOn < today;
}

export const formatOn = (iso: string | null): string => iso?.replaceAll("-", "/") ?? "—";

export const formatAmount = (yen: number | null): string => (yen === null ? "—" : `¥${yen.toLocaleString("ja-JP")}`);

const SORT_VALUE: Record<string, (l: Lead) => string | number | null> = {
  company: (l) => l.companyName,
  status: (l) => statusRank(l.status),
  priority: (l) => (l.priority ? -sponsor.LEAD_PRIORITIES.indexOf(l.priority) : null),
  owner: (l) => l.owner,
  plan: (l) => l.plan,
  lastContactOn: (l) => l.lastContactOn,
  nextActionOn: (l) => l.nextActionOn,
  amount: (l) => l.expectedAmount,
};

/** 空欄は向きに関係なく末尾。同順位は企業名順。 */
export function sortLeads(rows: readonly Lead[], key: string, direction: "asc" | "desc"): Lead[] {
  const get = SORT_VALUE[key] ?? SORT_VALUE.status!;
  const dir = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) {
      return (typeof x === "number" ? x - (y as number) : x.localeCompare(y as string, "ja")) * dir;
    }
    return a.companyName.localeCompare(b.companyName, "ja");
  });
}
