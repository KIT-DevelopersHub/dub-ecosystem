// これまでの組織図(#890 時点・本番と同じ見た目)。組織図タブの表示切り替えの「これまでの表示」。
// origin/main の OrgChartView.tsx をそのまま写したもの(新しい表示は OrgChartView.tsx)。
// 組織図ビュー — 代表(横長ダークネイビー箱) → チーム色のカード → カードの中に「班」を横並び。
//   班 = チーム内のリーダー(position=leader、無ければ roleTitle から推定)と、leaderId を上へ
//   たどってそのリーダーに行き着くメンバー。リーダーの leaderId が同じチームの別リーダーを指す
//   場合は同じ班の共同リーダーとして並べる。班名は専用の項目が無いので、先頭リーダーの役割
//   (「広報リーダー」→「広報班」)、取れない・重なる時は姓(「石井班」)から作る。
//   班に入らない人(オーガナイザー・リーダー未設定)はカード上部に従来の親子ツリーで出す。
//   リーダーが居ないチームは従来どおり leaderId の親子ツリーだけを描く。
import { useRef, type CSSProperties } from "react";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { tierOf as roleTierOf, type Tier } from "./orgChartOrder.ts";
import { activityRank, statusGroup, statusLabel } from "./memberStatus.ts";
import { ORG_CHART_PAGE_CSS, useFitChartToPrintedPage } from "./orgChartPrint.ts";
import styles from "./orgChartLegacy.module.css";

const HQ_NAVY = "#1e3a5f";

/** 統括チームの判定（名前/keyに「統括」相当を含む）。 */
function isHqTeam(t: MemberTeam): boolean {
  return /統括/.test(t.name) || t.key === "soukatsu" || t.key === "hq";
}

/** 法人チームの判定。組織図には載せない（運営メンバー画面のチーム別には残す）。 */
function isCorporateTeam(t: MemberTeam): boolean {
  return /法人/.test(t.name) || t.key === "houjin";
}

/**
 * 上部「代表」箱に出す人 = 統括チームのうち役割に「代表」を含む人（副代表も含む）。
 * 代表 → 副代表 → 並び順。統括チームの列と重複して載るのは意図どおり。
 */
function representativesOf(hqMembers: OrgMember[]): OrgMember[] {
  const rank = (m: OrgMember): number => (/副代表/.test(m.roleTitle ?? "") ? 1 : 0);
  return hqMembers.filter((m) => /代表/.test(m.roleTitle ?? "")).sort((a, b) => rank(a) - rank(b) || bySortOrder(a, b));
}

/** 役職は position(明示)を優先し、無ければ roleTitle から推定する。 */
function tierOf(m: OrgMember): Tier {
  return m.position ?? roleTierOf(m);
}

const TIER_RANK: Record<Tier, number> = { organizer: 0, leader: 1, member: 2 };
function bySortOrder(a: OrgMember, b: OrgMember): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** 打診中・休み中は活動中の人の下に回す。 */
function byActivityThenTier(a: OrgMember, b: OrgMember): number {
  return activityRank(a.status) - activityRank(b.status) || TIER_RANK[tierOf(a)] - TIER_RANK[tierOf(b)] || bySortOrder(a, b);
}

type TreeNode = { m: OrgMember; children: TreeNode[] };

/**
 * 1チーム分のメンバーを leaderId の親子ツリーに組む。
 * - root = リーダー未設定、または上長がこのカラム外に居る人（＝この列の最上位）。
 * - 各ノードの children = leaderId がその人を指すメンバー。
 * - cycle は visited ガードで打ち切り、取りこぼした人は root に回して誰も消えないようにする。
 */
function buildTeamTree(members: OrgMember[]): TreeNode[] {
  const idSet = new Set(members.map((m) => m.id));
  const childrenOf = new Map<string, OrgMember[]>();
  const roots: OrgMember[] = [];
  for (const m of members) {
    const lid = m.leaderId ?? null;
    if (lid && lid !== m.id && idSet.has(lid)) {
      const arr = childrenOf.get(lid) ?? [];
      arr.push(m);
      childrenOf.set(lid, arr);
    } else {
      roots.push(m);
    }
  }
  for (const arr of childrenOf.values()) arr.sort(byActivityThenTier);
  roots.sort(byActivityThenTier);

  const seen = new Set<string>();
  const build = (m: OrgMember): TreeNode => {
    seen.add(m.id);
    const kids = (childrenOf.get(m.id) ?? []).filter((c) => !seen.has(c.id));
    return { m, children: kids.map(build) };
  };
  const tree = roots.map(build);
  // cycle fallback: どのツリーにも入らなかった人（相互参照など）を root として拾う。
  for (const m of members.filter((x) => !seen.has(x.id)).sort(byActivityThenTier)) {
    tree.push(build(m));
  }
  return tree;
}

type Squad = { id: string; name: string; leaders: OrgMember[]; tree: TreeNode[] };

/** 班名の候補: 「広報リーダー」→「広報班」。役割から取れなければ姓。 */
function squadBaseName(head: OrgMember): string {
  const base = (head.roleTitle ?? "").replace(/リーダー|leader/gi, "").trim();
  return base ? `${base}班` : surnameSquadName(head);
}
function surnameSquadName(head: OrgMember): string {
  return `${head.name.split(/[\s\u3000]+/)[0] || head.name}班`;
}

/**
 * 1チーム分を「班に入らない人」と「班」の並びに分ける。
 * - 班の先頭 = リーダーのうち、leaderId をたどって同じチームのリーダーに当たらない人。
 * - 共同リーダー = leaderId が同じチームのリーダーを指すリーダー(先頭の班に入る)。
 * - メンバー = leaderId を上へたどり、最初に当たったリーダーの班へ。当たらなければ班の外。
 * 循環は seen で打ち切る。リーダーが居なければ squads は空(従来の描画)。
 */
function buildTeamSquads(members: OrgMember[]): { rest: TreeNode[]; squads: Squad[] } {
  const byId = new Map(members.map((m) => [m.id, m]));
  const isLeader = (m: OrgMember): boolean => tierOf(m) === "leader";
  const leaders = members.filter(isLeader);
  if (leaders.length === 0) return { rest: buildTeamTree(members), squads: [] };

  const headOf = (l: OrgMember): OrgMember => {
    const seen = new Set([l.id]);
    let cur = l;
    for (;;) {
      const up = byId.get(cur.leaderId ?? "");
      if (!up || !isLeader(up) || seen.has(up.id)) return cur;
      seen.add(up.id);
      cur = up;
    }
  };
  const firstLeaderOf = (m: OrgMember): OrgMember | undefined => {
    const seen = new Set([m.id]);
    let id = m.leaderId ?? null;
    while (id && !seen.has(id)) {
      seen.add(id);
      const up = byId.get(id);
      if (!up) return undefined;
      if (isLeader(up)) return up;
      id = up.leaderId ?? null;
    }
    return undefined;
  };

  const groups = new Map<string, { head: OrgMember; leaders: OrgMember[]; members: OrgMember[] }>();
  for (const l of [...leaders].sort(byActivityThenTier)) {
    const head = headOf(l);
    const g = groups.get(head.id) ?? { head, leaders: [], members: [] };
    g.leaders.push(l);
    groups.set(head.id, g);
  }
  const rest: OrgMember[] = [];
  for (const m of members) {
    if (isLeader(m)) continue;
    const lead = tierOf(m) === "organizer" ? undefined : firstLeaderOf(m);
    if (lead) groups.get(headOf(lead).id)!.members.push(m);
    else rest.push(m);
  }

  const ordered = [...groups.values()].sort((a, b) => byActivityThenTier(a.head, b.head));
  const names = ordered.map((g) => squadBaseName(g.head));
  const squads = ordered.map((g, i) => {
    const dup = names.filter((n) => n === names[i]).length > 1;
    // 先頭リーダーを最初に、共同リーダーは活動順。
    const ls = [g.head, ...g.leaders.filter((l) => l.id !== g.head.id)];
    return { id: g.head.id, name: dup ? surnameSquadName(g.head) : names[i]!, leaders: ls, tree: buildTeamTree(g.members) };
  });
  return { rest: buildTeamTree(rest), squads };
}

/** 1人分のノード。tier で見た目の強さを、status でバッジ/淡色を出し分ける。 */
function OrgNode({ node }: { node: TreeNode }): JSX.Element {
  const { m, children } = node;
  const tier = tierOf(m);
  const grp = statusGroup(m.status);
  const badge = statusLabel(m.status); // "" | 打診中 | 休み中（declined は上位で除外済み）
  const cls = [
    styles.node,
    tier === "organizer" ? styles.nOrg : tier === "leader" ? styles.nLead : styles.nMember,
    grp === "pending" ? styles.tent : "",
    grp === "onLeave" ? styles.leave : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={styles.nodeItem}>
      <div className={cls} data-testid={`members-orgchip-${m.id}`}>
        <span className={styles.nodeName}>{m.name}</span>
        {m.roleTitle ? <span className={styles.nodeRole}>{m.roleTitle}</span> : null}
        {m.grade ? <span className={styles.nodeGrade}>{m.grade}</span> : null}
        {badge ? <span className={styles.nodeBadge}>{badge}</span> : null}
      </div>
      {children.length > 0 ? (
        <ul className={styles.nodeChildren}>
          {children.map((c) => (
            <OrgNode key={c.m.id} node={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TreeList({ nodes }: { nodes: TreeNode[] }): JSX.Element | null {
  if (nodes.length === 0) return null;
  return (
    <ul className={styles.tree}>
      {nodes.map((n) => (
        <OrgNode key={n.m.id} node={n} />
      ))}
    </ul>
  );
}

function SquadBox({ squad }: { squad: Squad }): JSX.Element {
  return (
    <section className={styles.squad} data-testid={`members-orgsquad-${squad.id}`} aria-label={squad.name}>
      <div className={styles.squadName}>{squad.name}</div>
      <ul className={styles.squadLeaders} data-testid={`members-orgsquad-leaders-${squad.id}`}>
        {squad.leaders.map((l) => (
          <OrgNode key={l.id} node={{ m: l, children: [] }} />
        ))}
      </ul>
      {squad.tree.length > 0 ? (
        <div className={styles.squadMembers}>
          <TreeList nodes={squad.tree} />
        </div>
      ) : null}
    </section>
  );
}

function TeamColumn({ team, members }: { team: MemberTeam; members: OrgMember[] }): JSX.Element {
  const color = team.color ?? "#64748b";
  const { rest, squads } = buildTeamSquads(members);
  const tent = members.filter((m) => statusGroup(m.status) === "pending").length;
  const cls = [styles.orgCol, squads.length > 1 ? styles.orgColWide : ""].filter(Boolean).join(" ");

  return (
    <div
      className={cls}
      style={{ ["--team" as string]: color, ["--squads" as string]: squads.length } as CSSProperties}
      data-testid={`members-orgcol-${team.id}`}
    >
      <div className={styles.colHead}>
        <div className={styles.colName}>{team.name}</div>
        {team.description ? <div className={styles.colDesc}>{team.description}</div> : null}
      </div>
      <div className={styles.colBody}>
        <TreeList nodes={rest} />
        {squads.length > 0 ? (
          <div className={styles.squadRow} data-testid={`members-orgsquads-${team.id}`}>
            {squads.map((sq) => (
              <SquadBox key={sq.id} squad={sq} />
            ))}
          </div>
        ) : null}
        <div className={styles.colCount}>
          計{members.length}名{squads.length > 0 ? ` ／ ${squads.length}班` : ""}
          {tent > 0 ? `（うち打診中${tent}）` : ""}
        </div>
      </div>
    </div>
  );
}

/** 代表箱からチームの並びへ下りる線。チームは画面幅で折り返すので、列ごとの分岐線は引かない。 */
function Connector(): JSX.Element {
  return (
    <div className={styles.connector} aria-hidden>
      <div className={styles.vtop} />
    </div>
  );
}

export function OrgChartLegacyView({ teams: allTeams, members }: { teams: MemberTeam[]; members: OrgMember[] }): JSX.Element {
  const chartRef = useRef<HTMLDivElement>(null);
  useFitChartToPrintedPage(chartRef);
  const teams = allTeams.filter((t) => !isCorporateTeam(t));
  const corporateIds = new Set(allTeams.filter(isCorporateTeam).map((t) => t.id));
  // 法人チームにしか所属しない人は載せない。他チームにも居る人はそのチームの列に残す。
  const onlyCorporate = (m: OrgMember): boolean => m.teamIds.length > 0 && m.teamIds.every((id) => corporateIds.has(id));
  // 辞退(declined)は体制図に出さない。
  const active = members.filter((m) => m.status !== "declined" && !onlyCorporate(m));
  // 統括チームは他チームと同じ列として右端に並べる。
  const columnTeams = [...teams.filter((t) => !isHqTeam(t)), ...teams.filter(isHqTeam)];
  const inTeam = (teamId: string): OrgMember[] => active.filter((m) => m.teamIds.includes(teamId));
  const reps = representativesOf(active.filter((m) => teams.some((t) => isHqTeam(t) && m.teamIds.includes(t.id))));

  // 各 active メンバーをチーム列に配置しつつ、どこに描画したかを記録する（代表箱は列の外の重複表示なので数えない）。
  const placed = new Set<string>();
  const columns: Array<{ team: MemberTeam; members: OrgMember[] }> = columnTeams.map((t) => {
    const cm = inTeam(t.id);
    for (const m of cm) placed.add(m.id);
    return { team: t, members: cm };
  });
  // 取りこぼし防止（母集団の一致を保証）: HQにも列にも入らなかった active メンバーを全て拾い、
  // 体制図の下部に控えめな注記として並べる（チーム色・階層を持たせない）。
  const unassigned = active.filter((m) => !placed.has(m.id)).sort(byActivityThenTier);

  const totalConfirmed = active.filter((m) => m.status === "added").length;
  const totalTent = active.length - totalConfirmed;

  return (
    <div ref={chartRef} className={styles.orgChart} data-testid="members-orgchart" data-view="legacy">
      <style>{ORG_CHART_PAGE_CSS}</style>
      <div className={styles.orgHead}>
        <div className={styles.orgTitle}>全体組織体制図</div>
        <div className={styles.orgSub}>
          チームの中に班を並べ、班ごとにリーダーと配下メンバーを表示します
        </div>
        <div className={styles.orgLegend}>
          <span className={styles.li}>
            <span className={`${styles.legendSw} ${styles.swOrg}`} />
            オーガナイザー
          </span>
          <span className={styles.li}>
            <span className={`${styles.legendSw} ${styles.swLead}`} />
            リーダー
          </span>
          <span className={styles.li}>
            <span className={styles.legendSw} />
            メンバー
          </span>
          <span className={styles.li}>
            <span className={`${styles.legendSw} ${styles.tent}`} />
            打診中
          </span>
          <span className={styles.li}>
            <span className={`${styles.legendSw} ${styles.leave}`} />
            休み中
          </span>
        </div>
      </div>

      <div className={styles.orgScroll}>
        <div className={styles.orgCanvas}>
          {reps.length > 0 ? (
            <div className={styles.topbox} style={{ ["--hq" as string]: HQ_NAVY } as CSSProperties} data-testid="members-orgchart-reps">
              <div className={styles.topTitle}>代表</div>
              <div className={styles.topNames}>
                {reps.map((m) => {
                  const badge = statusLabel(m.status);
                  return (
                    <div key={m.id} className={styles.namechip} data-testid={`members-orgrep-${m.id}`}>
                      {m.name}
                      {m.roleTitle ? <span className={styles.namechipRole}>{m.roleTitle}</span> : null}
                      {badge ? <span className={styles.miniBadge}>{badge}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {reps.length > 0 && columns.length > 0 ? <Connector /> : null}

          <div className={styles.teamsRow} data-testid="fe2-orgchart-subgroups">
            {columns.map(({ team, members: cm }) => (
              <TeamColumn key={team.id} team={team} members={cm} />
            ))}
          </div>

          {unassigned.length > 0 ? (
            <div className={styles.orgUnassigned} data-testid="members-orgchart-unassigned">
              <span className={styles.orgUnassignedLabel}>未所属（チーム未割り当て）</span>
              <div className={styles.orgUnassignedNames}>
                {unassigned.map((m) => {
                  const badge = statusLabel(m.status);
                  return (
                    <span key={m.id} className={styles.orgUnassignedName} data-testid={`members-orgchip-${m.id}`}>
                      {m.name}
                      {badge ? <span className={styles.miniBadge}>{badge}</span> : null}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.orgFoot}>
        現メンバー計{totalConfirmed}名{totalTent > 0 ? `＋打診中${totalTent}名` : ""} ／ {columnTeams.length}チーム
      </div>
    </div>
  );
}
