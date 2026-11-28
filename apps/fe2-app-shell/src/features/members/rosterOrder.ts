// 名簿の並び順 (#873): 役職でまとめて Organizer → リーダー → メンバー。
// 同じ役職の中は組織図順 (orgChartOrder: チーム/リーダー配下・sortOrder) をそのまま保つ。
import type { OrgMember } from "./contracts.ts";
import { orgChartOrder, tierOf, type Tier } from "./orgChartOrder.ts";

/** identity の Organizer ロール (identity-roster schema の role_sys_organizer)。 */
export const ORGANIZER_ROLE_ID = "role_sys_organizer";

/** ロールを読むための identity ユーザーの最小形 (scopedRoleIds = イベント単位のロール・無くてもよい)。 */
export interface RoleHolder {
  id: string;
  roleIds?: readonly string[] | null;
  scopedRoleIds?: readonly string[] | null;
}

/** 団体全体かどこかのイベントで Organizer ロールを持つ identity ユーザーの id。 */
export function organizerIdentityIds(users: readonly RoleHolder[]): Set<string> {
  const ids = new Set<string>();
  for (const u of users) {
    if (u.roleIds?.includes(ORGANIZER_ROLE_ID) || u.scopedRoleIds?.includes(ORGANIZER_ROLE_ID)) ids.add(u.id);
  }
  return ids;
}

/** 名簿の役職区分: Organizer ロール > 役職 (position) > 役割 (roleTitle) からの推定。 */
export function rosterTier(m: OrgMember, organizerIds: ReadonlySet<string> = new Set()): Tier {
  if (m.identityUserId && organizerIds.has(m.identityUserId)) return "organizer";
  return m.position ?? tierOf(m);
}

const RANK: Record<Tier, number> = { organizer: 0, leader: 1, member: 2 };

/** Organizer → リーダー → メンバー の順に並べた新しい配列を返す (元配列は変えない)。 */
export function rosterOrder(members: readonly OrgMember[], organizerIds: ReadonlySet<string> = new Set()): OrgMember[] {
  return orgChartOrder(members)
    .map((m, i) => ({ m, i, rank: RANK[rosterTier(m, organizerIds)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.m);
}
