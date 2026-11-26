// 名簿を「組織図順」に並べ替える純粋関数。
//
// 組織図の縦の並び = オーガナイザー(統括/委員長など最上位) → 各リーダー → そのリーダーの
// 配下メンバー(leaderId で紐付く人) → リーダー未設定の一般メンバー、の順。leaderId が
// 明示されていれば親子でまとめ、無ければ roleTitle から段(tier)を推定してフォールバックする
// (既存の OrgChartView.tierOf と同じ判定基準)。cycle があっても placed セットで安全に打ち切る。
import type { OrgMember } from "./contracts.ts";

export type Tier = "organizer" | "leader" | "member";

/** roleTitle から役割段を推定する(OrgChartView と同一の基準)。 */
export function tierOf(m: OrgMember): Tier {
  const r = m.roleTitle ?? "";
  if (/オーガナイザー|統括|委員長|責任者|代表|実行委員長|チーム長/.test(r)) return "organizer";
  if (/リーダー|leader/i.test(r)) return "leader";
  return "member";
}

const TIER_RANK: Record<Tier, number> = { organizer: 0, leader: 1, member: 2 };

function bySortOrder(a: OrgMember, b: OrgMember): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function byTierThenSort(a: OrgMember, b: OrgMember): number {
  return TIER_RANK[tierOf(a)] - TIER_RANK[tierOf(b)] || bySortOrder(a, b);
}

/**
 * メンバー配列を組織図順に並べ替えて返す(元配列は変更しない)。
 * 1. leaderId で「配下」を集める(自己参照・org外参照は無視)。
 * 2. アンカー(オーガナイザー/リーダー、または誰かの leaderId に指名されている人)を
 *    tier→sortOrder で並べ、各アンカーの直後にその配下(再帰的に)を差し込む。
 * 3. どのアンカー配下にもならなかった残りを tier→sortOrder で末尾に付ける。
 */
export function orgChartOrder(members: readonly OrgMember[]): OrgMember[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const reportsOf = new Map<string, OrgMember[]>();
  for (const m of members) {
    const lid = m.leaderId ?? null;
    if (lid && lid !== m.id && byId.has(lid)) {
      const arr = reportsOf.get(lid) ?? [];
      arr.push(m);
      reportsOf.set(lid, arr);
    }
  }
  for (const arr of reportsOf.values()) arr.sort(bySortOrder);

  const isAnchor = (m: OrgMember): boolean => tierOf(m) !== "member" || reportsOf.has(m.id);
  const anchors = members.filter(isAnchor).sort(byTierThenSort);

  const placed = new Set<string>();
  const out: OrgMember[] = [];
  const pushReports = (id: string): void => {
    for (const r of reportsOf.get(id) ?? []) {
      if (placed.has(r.id)) continue;
      placed.add(r.id);
      out.push(r);
      pushReports(r.id); // nested leaders
    }
  };
  for (const a of anchors) {
    if (!placed.has(a.id)) {
      placed.add(a.id);
      out.push(a);
    }
    pushReports(a.id);
  }
  const rest = members.filter((m) => !placed.has(m.id)).sort(byTierThenSort);
  for (const m of rest) out.push(m);
  return out;
}
