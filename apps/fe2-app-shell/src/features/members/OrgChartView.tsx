// 組織図ビュー — 「誰がどのリーダーの配下か」が一目で分かる階層ツリー。
//   統括チーム(横長ダークネイビー箱) → コネクタ線 → チーム色の縦カラム。
//   各カラムの中は roleTitle の段ではなく leaderId の親子関係でネストして描く:
//     オーガナイザー → その配下のリーダー → 各リーダーの配下メンバー、を接続線＋
//     インデントでぶら下げる。これで「複数リーダーが居るチームでも、どのメンバーが
//     どのリーダーの下に付くか」が構造として即座に読める（FBの主眼）。
//   tier(役割段) は色の濃淡/枠の強さで補助表現し、上下関係そのものはネストで表す。
import type { CSSProperties } from "react";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { tierOf, type Tier } from "./orgChartOrder.ts";
import { statusGroup, statusLabel } from "./memberStatus.ts";
import styles from "./members.module.css";

const HQ_NAVY = "#1e3a5f";

/** 統括チームの判定（名前/keyに「統括」相当を含む）。 */
function isHqTeam(t: MemberTeam): boolean {
  return /統括/.test(t.name) || t.key === "soukatsu" || t.key === "hq";
}

const TIER_RANK: Record<Tier, number> = { organizer: 0, leader: 1, member: 2 };
function bySortOrder(a: OrgMember, b: OrgMember): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function byTierThenSort(a: OrgMember, b: OrgMember): number {
  return TIER_RANK[tierOf(a)] - TIER_RANK[tierOf(b)] || bySortOrder(a, b);
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
  for (const arr of childrenOf.values()) arr.sort(byTierThenSort);
  roots.sort(byTierThenSort);

  const seen = new Set<string>();
  const build = (m: OrgMember): TreeNode => {
    seen.add(m.id);
    const kids = (childrenOf.get(m.id) ?? []).filter((c) => !seen.has(c.id));
    return { m, children: kids.map(build) };
  };
  const tree = roots.map(build);
  // cycle fallback: どのツリーにも入らなかった人（相互参照など）を root として拾う。
  for (const m of members.filter((x) => !seen.has(x.id)).sort(byTierThenSort)) {
    tree.push(build(m));
  }
  return tree;
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

function TeamColumn({ team, members }: { team: MemberTeam; members: OrgMember[] }): JSX.Element {
  const color = team.color ?? "#64748b";
  const tree = buildTeamTree(members);
  const tent = members.filter((m) => statusGroup(m.status) === "pending").length;

  return (
    <div className={styles.orgCol} style={{ ["--team" as string]: color } as CSSProperties} data-testid={`members-orgcol-${team.id}`}>
      <div className={styles.colHead}>
        <div className={styles.colName}>{team.name}</div>
        {team.description ? <div className={styles.colDesc}>{team.description}</div> : null}
      </div>
      <div className={styles.colBody}>
        <ul className={styles.tree}>
          {tree.map((n) => (
            <OrgNode key={n.m.id} node={n} />
          ))}
        </ul>
        <div className={styles.colCount}>
          計{members.length}名{tent > 0 ? `（うち打診中${tent}）` : ""}
        </div>
      </div>
    </div>
  );
}

/** N列に分岐するコネクタ線（縦→横バー→各列への縦ドロップ）。 */
function Connector({ n }: { n: number }): JSX.Element {
  const edge = (100 / (2 * n)).toFixed(3);
  const drops = Array.from({ length: n }, (_, i) => (((2 * i + 1) / (2 * n)) * 100).toFixed(3));
  return (
    <div className={styles.connector} style={{ width: "100%" }} aria-hidden>
      <div className={styles.vtop} />
      <div className={styles.hbar} style={{ left: `${edge}%`, right: `${edge}%` }} />
      {drops.map((d) => (
        <div key={d} className={styles.vdrop} style={{ left: `${d}%` }} />
      ))}
    </div>
  );
}

export function OrgChartView({ teams, members }: { teams: MemberTeam[]; members: OrgMember[] }): JSX.Element {
  // 辞退(declined)は体制図に出さない。
  const active = members.filter((m) => m.status !== "declined");
  const hq = teams.find(isHqTeam) ?? null;
  const columnTeams = teams.filter((t) => !isHqTeam(t));
  const inTeam = (teamId: string): OrgMember[] => active.filter((m) => m.teamIds.includes(teamId));
  const hqMembers = hq ? inTeam(hq.id) : [];

  // 各 active メンバーを HQ箱 または チーム列 に配置しつつ、どこに描画したかを記録する。
  const placed = new Set<string>(hqMembers.map((m) => m.id));
  const columns: Array<{ team: MemberTeam; members: OrgMember[] }> = columnTeams.map((t) => {
    const cm = inTeam(t.id);
    for (const m of cm) placed.add(m.id);
    return { team: t, members: cm };
  });
  // 取りこぼし防止（母集団の一致を保証）: HQにも列にも入らなかった active メンバーを全て拾い、
  // 体制図の下部に控えめな注記として並べる（チーム色・階層を持たせない）。
  const unassigned = active.filter((m) => !placed.has(m.id));

  const totalConfirmed = active.filter((m) => m.status === "added").length;
  const totalTent = active.length - totalConfirmed;
  const hqColor = hq?.color ?? HQ_NAVY;

  return (
    <div className={styles.orgChart} data-testid="members-orgchart">
      <div className={styles.orgHead}>
        <div className={styles.orgTitle}>全体組織体制図</div>
        <div className={styles.orgSub}>
          各リーダーの下に配下メンバーをぶら下げて表示します（誰がどのリーダーの配下かが一目で分かります）
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
          {hq ? (
            <div className={styles.topbox} style={{ ["--hq" as string]: hqColor } as CSSProperties} data-testid="members-orgchart-hq">
              <div className={styles.topTitle}>{hq.name}</div>
              {hq.description ? <div className={styles.topRole}>{hq.description}</div> : null}
              <div className={styles.topNames}>
                {hqMembers.map((m) => {
                  const lead = tierOf(m) === "organizer";
                  const badge = statusLabel(m.status);
                  return (
                    <div
                      key={m.id}
                      className={`${styles.namechip} ${lead ? styles.lead : ""}`}
                      data-testid={`members-orgchip-${m.id}`}
                    >
                      {m.name}
                      {m.roleTitle ? <span className={styles.namechipRole}>{m.roleTitle}</span> : null}
                      {badge ? <span className={styles.miniBadge}>{badge}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {hq && columns.length > 0 ? <Connector n={columns.length} /> : null}

          <div className={styles.teamsRow}>
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
        {hq ? `＋統括${hqMembers.length}名` : ""}
      </div>
    </div>
  );
}
