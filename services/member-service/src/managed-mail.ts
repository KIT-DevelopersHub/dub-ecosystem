// 自分がマネジメントする範囲 (#942): mail-gateway が「この人はだれのメールを見てよいか」を聞く。
//   リーダー     → 自分の班のメンバー (組織図の班と同じ決め方・OrgChartView.buildTeamSquads)
//   オーガナイザー → 自分のチームのリーダーとメンバー (他のオーガナイザーは含まない)
// それより広くは返さない。見る側の役職は名簿の position (管理者が確定した値) だけで決め、
// roleTitle からの推定は使わない。見られる側の階層 (リーダーかメンバーか) は組織図と同じく
// position、無ければ roleTitle から推定する (広く取る方向に倒れないよう、推定でも上位なら外す)。
import type { mail, member } from "@dub/types";
import type { PersonRow } from "./types";

type Tier = member.MemberPosition;

/** 組織図 (orgChartOrder.tierOf) と同じ roleTitle からの推定。 */
function roleTier(roleTitle: string | null): Tier {
  const r = roleTitle ?? "";
  if (/オーガナイザー|統括|委員長|責任者|代表|実行委員長|チーム長/.test(r)) return "organizer";
  if (/リーダー|leader/i.test(r)) return "leader";
  return "member";
}
function tierOf(p: PersonRow): Tier {
  return p.position ?? roleTier(p.roleTitle);
}

/** 1 チーム分の班: 班の先頭リーダー id -> その班のメンバー (リーダー・オーガナイザーを除く)。 */
function squadsOf(team: PersonRow[]): { headOf: (l: PersonRow) => PersonRow; members: Map<string, PersonRow[]> } {
  const byId = new Map(team.map((p) => [p.id, p]));
  const isLeader = (p: PersonRow): boolean => tierOf(p) === "leader";
  const headOf = (l: PersonRow): PersonRow => {
    const seen = new Set([l.id]);
    let cur = l;
    for (;;) {
      const up = byId.get(cur.leaderId ?? "");
      if (!up || !isLeader(up) || seen.has(up.id)) return cur;
      seen.add(up.id);
      cur = up;
    }
  };
  const firstLeaderOf = (p: PersonRow): PersonRow | undefined => {
    const seen = new Set([p.id]);
    let id = p.leaderId ?? null;
    while (id && !seen.has(id)) {
      seen.add(id);
      const up = byId.get(id);
      if (!up) return undefined;
      if (isLeader(up)) return up;
      id = up.leaderId ?? null;
    }
    return undefined;
  };
  const members = new Map<string, PersonRow[]>();
  for (const p of team) {
    if (tierOf(p) !== "member") continue;
    const lead = firstLeaderOf(p);
    if (!lead) continue;
    const head = headOf(lead).id;
    members.set(head, [...(members.get(head) ?? []), p]);
  }
  return { headOf, members };
}

/**
 * `viewerUserId` (identity id) が読み取り専用で開いてよいメンバーのメールボックス。
 * 見る側が在籍 (added) で名簿にリンクされ、役職が leader / organizer のときだけ空でない。
 * 見られる側は identity にリンク済み・辞退 (declined) でない人だけ。自分は含めない。
 */
export function managedMailboxes(
  viewerUserId: string,
  people: readonly PersonRow[],
  links: ReadonlyArray<{ personId: string; teamId: string }>,
): mail.MailManagedMailbox[] {
  const viewer = people.find((p) => p.identityUserId === viewerUserId);
  if (!viewer || viewer.status !== "added") return [];
  if (viewer.position !== "leader" && viewer.position !== "organizer") return [];

  const myTeams = new Set(links.filter((l) => l.personId === viewer.id).map((l) => l.teamId));
  if (myTeams.size === 0) return [];
  const active = people.filter((p) => p.status !== "declined");
  const teamOf = (teamId: string): PersonRow[] => {
    const ids = new Set(links.filter((l) => l.teamId === teamId).map((l) => l.personId));
    return active.filter((p) => ids.has(p.id));
  };

  const picked: PersonRow[] = [];
  for (const teamId of myTeams) {
    const team = teamOf(teamId);
    if (viewer.position === "organizer") {
      picked.push(...team.filter((p) => tierOf(p) !== "organizer"));
    } else if (team.some((p) => p.id === viewer.id)) {
      const { headOf, members } = squadsOf(team);
      picked.push(...(members.get(headOf(viewer).id) ?? []));
    }
  }

  const relation: mail.MailManagedRelation = viewer.position === "organizer" ? "team" : "squad";
  const out: mail.MailManagedMailbox[] = [];
  const seen = new Set<string>([viewerUserId]);
  for (const p of picked) {
    const uid = p.identityUserId;
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ userId: uid, name: p.name, relation });
  }
  return out;
}
