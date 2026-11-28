// 目標タブの補助。目標値・実績・達成率は member-service が目標管理の KPI と同じ集計で返す (@dub/types goal が SoT)。
import { sponsor } from "@dub/types";

/** 達した節目の日付が空の企業 = 実績に入らない分がある企業 (スプレッドシートから移した過去分など)。見送りは節目が分からないので除く。 */
export function undatedLeads(leads: readonly sponsor.SponsorLead[]): number {
  return leads.filter((l) =>
    sponsor.LEAD_MILESTONES.some((m) => sponsor.leadStatusRank(l.status) >= sponsor.leadStatusRank(m.reachedAt) && l[m.field] === null),
  ).length;
}
