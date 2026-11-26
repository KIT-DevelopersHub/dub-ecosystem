// 組織図ビュー — 代表(横長ダークネイビー箱) → チーム色の帯を縦に 1 段ずつ → 帯の中は単位の木。
//   単位 = オーガナイザーのグループ / リーダーの班。木は左 → 右に深くなり、子の単位は親の右に
//   縦 1 列で並ぶ。どの深さでも同じ形で再帰する(チーム → オーガナイザーごとのグループ → 班 → …)。親子は leaderId だけで決め、
//   リーダーの leaderId が同じチームの別リーダーを指す場合は同じ班の共同リーダーとして並べる。
//   班名は先頭リーダーの役割(「広報リーダー」→「広報班」)、取れない・重なる時は姓(「石井班」)。
//   どの単位にもつかない人は「リーダー未設定」の箱へ。頭が誰も居ないチームは従来の親子ツリー。
import { useRef, type CSSProperties } from "react";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { tierOf as roleTierOf, type Tier } from "./orgChartOrder.ts";
import { activityRank, statusGroup, statusLabel } from "./memberStatus.ts";
import { ORG_CHART_PAGE_CSS, useFitChartToPrintedPage } from "./orgChartPrint.ts";
import styles from "./members.module.css";

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

/**
 * 組織図の 1 単位(グループ / 班)。子の単位は親の右に縦 1 列で並べ、どの深さでも同じ形で再帰する。
 * - group = オーガナイザー 1 人を頭にした単位(配下の班・メンバーを持つ)。
 * - squad = 班。リーダー(＋共同リーダー)を頭にした単位。
 * - loose = 単位を持つチームで、どのオーガナイザー/リーダーにもつかない人の置き場。
 */
type UnitKind = "group" | "squad" | "loose";
export type OrgUnit = { kind: UnitKind; id: string; name: string; heads: OrgMember[]; members: TreeNode[]; units: OrgUnit[] };

/** 班名の候補: 「広報リーダー」→「広報班」。役割から取れなければ姓。 */
function squadBaseName(head: OrgMember): string {
  const base = (head.roleTitle ?? "").replace(/リーダー|leader/gi, "").trim();
  return base ? `${base}班` : surnameSquadName(head);
}
function surname(m: OrgMember): string {
  return m.name.split(/[\s\u3000]+/)[0] || m.name;
}
function surnameSquadName(head: OrgMember): string {
  return `${surname(head)}班`;
}

/**
 * 1 チーム分を単位の木に組む。親子はすべて leaderId から決める。
 * - 頭 = オーガナイザー(1 人 1 グループ)とリーダー。leaderId が同じチームのリーダーを指す
 *   リーダーは共同リーダーとして同じ班に入る。
 * - 単位の親 = 頭から leaderId を上へたどって最初に当たった別の単位(オーガナイザー→オーガナイザーも可)。
 * - メンバー = leaderId を上へたどって最初に当たった単位へ。当たらなければ loose。
 * - オーガナイザーが 1 人だけのチームでは、親の決まらない班をそのオーガナイザーの下に置く。
 * 循環は seen で打ち切る。頭が誰も居なければ units は空(従来の親子ツリーで描く)。
 */
export function buildTeamUnits(members: OrgMember[], teamId = "team"): { rest: TreeNode[]; units: OrgUnit[] } {
  const byId = new Map(members.map((m) => [m.id, m]));
  const isLeader = (m: OrgMember): boolean => tierOf(m) === "leader";
  const isOrganizer = (m: OrgMember): boolean => tierOf(m) === "organizer";
  if (!members.some((m) => isLeader(m) || isOrganizer(m))) return { rest: buildTeamTree(members), units: [] };

  // リーダーの班の頭 = leaderId を同じチームのリーダーへたどれる限り上った人。
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
  /** その人が属する単位の id(頭なら自分の単位)。 */
  const unitIdOf = (m: OrgMember): string | undefined =>
    isOrganizer(m) ? m.id : isLeader(m) ? headOf(m).id : undefined;
  /** leaderId を上へたどり、最初に当たった単位の id(自分の単位 self は飛ばす)。 */
  const unitAbove = (m: OrgMember, self?: string): string | undefined => {
    const seen = new Set([m.id]);
    let id = m.leaderId ?? null;
    while (id && !seen.has(id)) {
      seen.add(id);
      const up = byId.get(id);
      if (!up) return undefined;
      const u = unitIdOf(up);
      if (u && u !== self) return u;
      id = up.leaderId ?? null;
    }
    return undefined;
  };

  type Draft = { kind: "group" | "squad"; head: OrgMember; heads: OrgMember[]; members: OrgMember[]; parent?: string };
  const drafts = new Map<string, Draft>();
  for (const m of [...members].sort(byActivityThenTier)) {
    const uid = unitIdOf(m);
    if (!uid) continue;
    const head = byId.get(uid)!;
    const d = drafts.get(uid) ?? { kind: isOrganizer(head) ? "group" : "squad", head, heads: [], members: [] };
    d.heads.push(m);
    drafts.set(uid, d);
  }
  const loose: OrgMember[] = [];
  for (const m of members) {
    if (unitIdOf(m)) continue;
    const uid = unitAbove(m);
    if (uid) drafts.get(uid)!.members.push(m);
    else loose.push(m);
  }
  for (const [id, d] of drafts) d.parent = unitAbove(d.head, id);
  // 単位どうしの循環(O1→O2→O1 など)は、その単位を根に戻して切る。
  for (const [id, d] of drafts) {
    const seen = new Set([id]);
    let p = d.parent;
    while (p) {
      if (seen.has(p)) {
        d.parent = undefined;
        break;
      }
      seen.add(p);
      p = drafts.get(p)?.parent;
    }
  }
  const rootGroups = [...drafts.values()].filter((d) => !d.parent && d.kind === "group");
  if (rootGroups.length === 1) {
    const only = rootGroups[0]!;
    for (const d of drafts.values()) if (!d.parent && d.kind === "squad") d.parent = only.head.id;
  }

  // 班名(重なる時は姓)。グループ名はオーガナイザーの姓。
  const squadDrafts = [...drafts.values()].filter((d) => d.kind === "squad");
  const baseNames = new Map(squadDrafts.map((d) => [d.head.id, squadBaseName(d.head)]));
  const nameOf = (d: Draft): string => {
    if (d.kind === "group") return `${surname(d.head)}グループ`;
    const n = baseNames.get(d.head.id)!;
    return [...baseNames.values()].filter((x) => x === n).length > 1 ? surnameSquadName(d.head) : n;
  };
  const build = (d: Draft): OrgUnit => {
    const kids = [...drafts.values()].filter((c) => c.parent === d.head.id).sort((a, b) => byActivityThenTier(a.head, b.head));
    return { kind: d.kind, id: d.head.id, name: nameOf(d), heads: d.heads, members: buildTeamTree(d.members), units: kids.map(build) };
  };
  const units = [...drafts.values()]
    .filter((d) => !d.parent)
    .sort((a, b) => byActivityThenTier(a.head, b.head))
    .map(build);
  if (loose.length > 0) {
    units.push({ kind: "loose", id: teamId, name: "リーダー未設定", heads: [], members: buildTeamTree(loose), units: [] });
  }
  return { rest: [], units };
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

const UNIT_TESTID: Record<UnitKind, string> = { group: "members-orggroup", squad: "members-orgsquad", loose: "members-orgloose" };

/** 子の単位を親の右側に縦 1 列で並べる(左 → 右に深くなる)。どの深さでも同じ。 */
function UnitColumn({ units, testId }: { units: OrgUnit[]; testId: string }): JSX.Element {
  return (
    <div className={styles.unitChildren} data-layout="column" data-testid={testId}>
      {units.map((u) => (
        <UnitBox key={u.id} unit={u} />
      ))}
    </div>
  );
}

/** 1 単位: 左に自分(頭 → 配下メンバー)、右に子の単位の列。 */
function UnitBox({ unit }: { unit: OrgUnit }): JSX.Element {
  const base = UNIT_TESTID[unit.kind];
  const cls = [styles.unitSelf, unit.kind === "group" ? styles.unitGroup : unit.kind === "loose" ? styles.unitLoose : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <section className={styles.unit} data-layout="ltr" data-testid={`${base}-${unit.id}`} data-unit={unit.kind} aria-label={unit.name}>
      <div className={cls}>
        {unit.kind !== "group" ? <div className={styles.squadName}>{unit.name}</div> : null}
        {unit.heads.length > 0 ? (
          <ul className={styles.squadLeaders} data-testid={`${base}-leaders-${unit.id}`}>
            {unit.heads.map((l) => (
              <OrgNode key={l.id} node={{ m: l, children: [] }} />
            ))}
          </ul>
        ) : null}
        {unit.members.length > 0 ? (
          <div className={unit.kind === "loose" ? undefined : styles.squadMembers}>
            <TreeList nodes={unit.members} />
          </div>
        ) : null}
      </div>
      {unit.units.length > 0 ? <UnitColumn units={unit.units} testId={`members-orgunits-${unit.id}`} /> : null}
    </section>
  );
}

function countSquads(units: OrgUnit[]): number {
  return units.reduce((n, u) => n + (u.kind === "squad" ? 1 : 0) + countSquads(u.units), 0);
}

function TeamColumn({ team, members }: { team: MemberTeam; members: OrgMember[] }): JSX.Element {
  const color = team.color ?? "#64748b";
  const { rest, units } = buildTeamUnits(members, team.id);
  const squads = countSquads(units);
  const tent = members.filter((m) => statusGroup(m.status) === "pending").length;

  return (
    <div
      className={styles.orgCol}
      style={{ ["--team" as string]: color } as CSSProperties}
      data-layout="ltr"
      data-testid={`members-orgcol-${team.id}`}
    >
      <div className={styles.colHead}>
        <div className={styles.colName}>{team.name}</div>
        {team.description ? <div className={styles.colDesc}>{team.description}</div> : null}
        <div className={styles.colCount}>
          計{members.length}名{squads > 0 ? ` ／ ${squads}班` : ""}
          {tent > 0 ? `（うち打診中${tent}）` : ""}
        </div>
      </div>
      <div className={styles.colBody}>
        {rest.length > 0 ? (
          <div className={styles.colRest}>
            <TreeList nodes={rest} />
          </div>
        ) : null}
        {units.length > 0 ? <UnitColumn units={units} testId={`members-orgsquads-${team.id}`} /> : null}
      </div>
    </div>
  );
}

/** 代表箱からチームの並びへ下りる線。チームは縦に 1 段ずつ、各チームの中は左 → 右。 */
function Connector(): JSX.Element {
  return (
    <div className={styles.connector} aria-hidden>
      <div className={styles.vtop} />
    </div>
  );
}

export function OrgChartView({ teams: allTeams, members }: { teams: MemberTeam[]; members: OrgMember[] }): JSX.Element {
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
    <div ref={chartRef} className={styles.orgChart} data-testid="members-orgchart">
      <style>{ORG_CHART_PAGE_CSS}</style>
      <div className={styles.orgHead}>
        <div className={styles.orgTitle}>全体組織体制図</div>
        <div className={styles.orgSub}>
          チーム → オーガナイザーごとのグループ → 班 の順に、左から右へ階層をたどります
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

          <div className={styles.teamsRow} data-layout="column" data-testid="fe2-orgchart-subgroups">
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
