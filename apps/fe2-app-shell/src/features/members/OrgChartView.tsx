// 組織図ビュー — 「誰がどのリーダーの配下か」が一目で分かる横並びの体制図。
//   上段: オーガナイザーを横並び(ダークネイビー箱) → コネクタ線 →
//   下段: リーダーを横並びの列にし、各リーダーの列の下へ配下メンバーを縦に並べる。
//   配下 = leaderId を上へたどって最初に当たったリーダー(入れ子でも直属のリーダー列に入る)。
//   リーダーに辿り着かない人は末尾の「リーダー未設定」列。振り分けは memberHierarchy.ts(共有)。
//   列の色は リーダーの所属チームの色。tier(役割段) は色の濃淡/枠の強さで補助表現する。
import { useRef, type CSSProperties } from "react";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { type Tier } from "./orgChartOrder.ts";
import { buildMemberHierarchy, positionOf } from "./memberHierarchy.ts";
import { activityRank, statusGroup, statusLabel } from "./memberStatus.ts";
import { ORG_CHART_PAGE_CSS, useFitChartToPrintedPage } from "./orgChartPrint.ts";
import styles from "./members.module.css";

const HQ_NAVY = "#1e3a5f";
const NEUTRAL = "#64748b";

/** 法人チームの判定。組織図には載せない（運営メンバー画面のチーム別には残す）。 */
function isCorporateTeam(t: MemberTeam): boolean {
  return /法人/.test(t.name) || t.key === "houjin";
}

const TIER_RANK: Record<Tier, number> = { organizer: 0, leader: 1, member: 2 };
function bySortOrder(a: OrgMember, b: OrgMember): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** 打診中・休み中は活動中の人の下に回す。 */
function byActivityThenTier(a: OrgMember, b: OrgMember): number {
  return activityRank(a.status) - activityRank(b.status) || TIER_RANK[positionOf(a)] - TIER_RANK[positionOf(b)] || bySortOrder(a, b);
}

/** 1人分のチップ。tier で見た目の強さを、status でバッジ/淡色を出し分ける。 */
function OrgNode({ m }: { m: OrgMember }): JSX.Element {
  const tier = positionOf(m);
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
    </li>
  );
}

/** 1列 = リーダー1人(見出し) + 配下メンバーを縦に。leader なしは「リーダー未設定」列。 */
function LeaderColumnView({
  id,
  leader,
  members,
  color,
  teamName,
}: {
  id: string;
  leader: OrgMember | null;
  members: OrgMember[];
  color: string;
  teamName: string | null;
}): JSX.Element {
  const sorted = [...members].sort(byActivityThenTier);
  const tent = members.filter((m) => statusGroup(m.status) === "pending").length;
  const leaderBadge = leader ? statusLabel(leader.status) : "";
  const headCls = [
    styles.colHead,
    leader && statusGroup(leader.status) === "pending" ? styles.colHeadTent : "",
    leader && statusGroup(leader.status) === "onLeave" ? styles.colHeadLeave : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={`${styles.orgCol} ${leader ? "" : styles.orgColUnassigned}`}
      style={{ ["--team" as string]: color } as CSSProperties}
      data-testid={`members-orgcol-${id}`}
    >
      <div className={headCls}>
        {leader ? (
          <>
            <div className={styles.colName} data-testid={`members-orgchip-${leader.id}`}>
              {leader.name}
              {leaderBadge ? <span className={styles.colBadge}>{leaderBadge}</span> : null}
            </div>
            {leader.roleTitle ? <div className={styles.colRole}>{leader.roleTitle}</div> : null}
            {teamName ? <div className={styles.colDesc}>{teamName}</div> : null}
          </>
        ) : (
          <div className={styles.colName}>リーダー未設定</div>
        )}
      </div>
      <div className={styles.colBody}>
        {sorted.length > 0 ? (
          <ul className={styles.tree}>
            {sorted.map((m) => (
              <OrgNode key={m.id} m={m} />
            ))}
          </ul>
        ) : (
          <div className={styles.colEmpty}>配下のメンバーはいません</div>
        )}
        <div className={styles.colCount}>
          配下{members.length}名{tent > 0 ? `（うち打診中${tent}）` : ""}
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

export function OrgChartView({ teams: allTeams, members }: { teams: MemberTeam[]; members: OrgMember[] }): JSX.Element {
  const chartRef = useRef<HTMLDivElement>(null);
  useFitChartToPrintedPage(chartRef);
  const teams = allTeams.filter((t) => !isCorporateTeam(t));
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const corporateIds = new Set(allTeams.filter(isCorporateTeam).map((t) => t.id));
  // 法人チームにしか所属しない人は載せない。他チームにも居る人は載せる。
  const onlyCorporate = (m: OrgMember): boolean => m.teamIds.length > 0 && m.teamIds.every((id) => corporateIds.has(id));
  // 辞退(declined)は体制図に出さない。
  const active = members.filter((m) => m.status !== "declined" && !onlyCorporate(m));

  const { organizers, leaders, unassigned } = buildMemberHierarchy(active);
  const orgRow = [...organizers].sort(byActivityThenTier);
  const firstTeam = (m: OrgMember): MemberTeam | undefined =>
    m.teamIds.map((id) => teamsById.get(id)).find((t): t is MemberTeam => t !== undefined);
  const columnCount = leaders.length + (unassigned.length > 0 ? 1 : 0);

  const totalConfirmed = active.filter((m) => m.status === "added").length;
  const totalTent = active.length - totalConfirmed;

  return (
    <div ref={chartRef} className={styles.orgChart} data-testid="members-orgchart">
      <style>{ORG_CHART_PAGE_CSS}</style>
      <div className={styles.orgHead}>
        <div className={styles.orgTitle}>全体組織体制図</div>
        <div className={styles.orgSub}>
          上段にオーガナイザー、下段にリーダーを横に並べ、各リーダーの下に配下メンバーを縦に並べます
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

      <div className={styles.orgScroll} data-testid="fe2-orgchart-leader-columns">
        <div className={styles.orgCanvas}>
          {orgRow.length > 0 ? (
            <div className={styles.topbox} style={{ ["--hq" as string]: HQ_NAVY } as CSSProperties} data-testid="members-orgchart-organizers">
              <div className={styles.topTitle}>オーガナイザー</div>
              <div className={styles.topNames}>
                {orgRow.map((m) => {
                  const badge = statusLabel(m.status);
                  return (
                    <div key={m.id} className={styles.namechip} data-testid={`members-orgchip-${m.id}`}>
                      {m.name}
                      {m.roleTitle ? <span className={styles.namechipRole}>{m.roleTitle}</span> : null}
                      {badge ? <span className={styles.miniBadge}>{badge}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {orgRow.length > 0 && columnCount > 0 ? <Connector n={columnCount} /> : null}

          {columnCount > 0 ? (
            <div className={styles.teamsRow} data-testid="members-orgchart-leaders">
              {leaders.map(({ leader, members: cm }) => {
                const team = firstTeam(leader);
                return (
                  <LeaderColumnView
                    key={leader.id}
                    id={leader.id}
                    leader={leader}
                    members={cm}
                    color={team?.color ?? NEUTRAL}
                    teamName={team?.name ?? null}
                  />
                );
              })}
              {unassigned.length > 0 ? (
                <LeaderColumnView id="unassigned" leader={null} members={unassigned} color={NEUTRAL} teamName={null} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.orgFoot}>
        現メンバー計{totalConfirmed}名{totalTent > 0 ? `＋打診中${totalTent}名` : ""} ／ リーダー{leaders.length}名
      </div>
    </div>
  );
}
