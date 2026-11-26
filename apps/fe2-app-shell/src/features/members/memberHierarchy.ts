// オーガナイザー → リーダー → 各リーダーの配下 の振り分け(組織図・名簿で共有)。
// 役職は position(明示) → roleTitle からの推定(tierOf) の順で決める。メンバーは leaderId を上へ
// たどり、最初に当たったリーダーの列に入れる(辿れなければ「リーダー未設定」)。
// 並びは組織図順(orgChartOrder)を保つ。
import type { OrgMember } from "./contracts.ts";
import { orgChartOrder, tierOf, type Tier } from "./orgChartOrder.ts";

export function positionOf(m: OrgMember): Tier {
  return m.position ?? tierOf(m);
}

export interface LeaderColumn {
  leader: OrgMember;
  /** false = リーダー本人は絞り込みに合わないが、配下が合うので列の見出しとして出す。 */
  leaderVisible: boolean;
  members: OrgMember[];
}

export interface MemberHierarchy {
  organizers: OrgMember[];
  leaders: LeaderColumn[];
  unassigned: OrgMember[];
}

/**
 * all = 母集団(リーダーの解決に使う)、isVisible = 絞り込み(状態・検索など)。
 * 合わない人は出さず、誰も出ない列は消す。元配列は変更しない。
 */
export function buildMemberHierarchy(
  all: readonly OrgMember[],
  isVisible: (m: OrgMember) => boolean = () => true,
): MemberHierarchy {
  const ordered = orgChartOrder(all);
  const byId = new Map(ordered.map((m) => [m.id, m]));
  const columns = new Map<string, LeaderColumn>();
  for (const m of ordered) {
    if (positionOf(m) === "leader") columns.set(m.id, { leader: m, leaderVisible: isVisible(m), members: [] });
  }

  // leaderId を上へたどって最初のリーダー列を探す(循環は seen で打ち切る)。
  const columnOf = (m: OrgMember): LeaderColumn | undefined => {
    const seen = new Set([m.id]);
    let id = m.leaderId ?? null;
    while (id && !seen.has(id)) {
      seen.add(id);
      const col = columns.get(id);
      if (col) return col;
      id = byId.get(id)?.leaderId ?? null;
    }
    return undefined;
  };

  const organizers: OrgMember[] = [];
  const unassigned: OrgMember[] = [];
  for (const m of ordered) {
    const pos = positionOf(m);
    if (pos === "leader" || !isVisible(m)) continue;
    if (pos === "organizer") organizers.push(m);
    else (columnOf(m)?.members ?? unassigned).push(m);
  }
  const leaders = [...columns.values()].filter((c) => c.leaderVisible || c.members.length > 0);
  return { organizers, leaders, unassigned };
}
