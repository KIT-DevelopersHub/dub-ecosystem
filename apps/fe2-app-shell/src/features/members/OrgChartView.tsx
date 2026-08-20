// 組織図ビュー — 既存PDF「全体組織体制図」の構図をDBデータからDYNAMICに再現する。
//   統括チーム(横長ダークネイビー箱・白ピル) → コネクタ線 → チーム色の縦カラム
//   (オーガナイザー→リーダー→メンバー階層 / メンバーは「↳ 名前」インデント)。
// PDFはhardcodeだが本ビューは Team(color) と Member(roleTitle→役割段 / status) から
// 同じ構図を描く。印刷/PNGは MembersPage のツールバーの window.print() で出る。
import type { CSSProperties } from "react";
import type { MemberStatus, MemberTeam, OrgMember } from "./contracts.ts";
import styles from "./members.module.css";

const HQ_NAVY = "#1e3a5f";

/** 統括チームの判定（名前/keyに「統括」相当を含む）。 */
function isHqTeam(t: MemberTeam): boolean {
  return /統括/.test(t.name) || t.key === "soukatsu" || t.key === "hq";
}

type Tier = "organizer" | "leader" | "member";

/** メンバーの役割段を roleTitle から推定する（PDFの オーガナイザー/リーダー/メンバー 段）。 */
function tierOf(m: OrgMember): Tier {
  const r = m.roleTitle ?? "";
  if (/オーガナイザー|統括|委員長|責任者|代表|チーム長/.test(r)) return "organizer";
  if (/リーダー|leader/i.test(r)) return "leader";
  return "member";
}

/** 打診中(=未確定)扱い。added のみ確定、declined はビューから除外済み。 */
function isTentative(s: MemberStatus): boolean {
  return s === "invited" || s === "considering";
}
function tentBadge(s: MemberStatus): string {
  return s === "invited" ? "打診中" : "検討中";
}

function Chip({ m, kind }: { m: OrgMember; kind: "top" | "leader" | "sub" }): JSX.Element {
  const tent = isTentative(m.status);
  const cls = [styles.chip, kind === "top" ? styles.top : "", kind === "sub" ? styles.sub : "", tent ? styles.tent : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} data-testid={`members-orgchip-${m.id}`}>
      {kind === "sub" ? "↳ " : ""}
      {m.name}
      {kind === "sub" ? <span className={styles.subrole}>メンバー</span> : null}
      {m.grade ? <span className={styles.subrole}>{m.grade}</span> : null}
      {tent ? <span className={styles.chipBadge}>{tentBadge(m.status)}</span> : null}
    </div>
  );
}

function TeamColumn({ team, members }: { team: MemberTeam; members: OrgMember[] }): JSX.Element {
  const color = team.color ?? "#64748b";
  const organizers = members.filter((m) => tierOf(m) === "organizer");
  const leaders = members.filter((m) => tierOf(m) === "leader");
  const plain = members.filter((m) => tierOf(m) === "member");
  const confirmed = members.filter((m) => m.status === "added").length;
  const tent = members.length - confirmed;

  return (
    <div className={styles.orgCol} style={{ ["--team" as string]: color } as CSSProperties} data-testid={`members-orgcol-${team.id}`}>
      <div className={styles.colHead}>
        <div className={styles.colName}>{team.name}</div>
        {team.description ? <div className={styles.colDesc}>{team.description}</div> : null}
      </div>
      <div className={styles.colBody}>
        {organizers.length > 0 ? (
          <>
            <div className={styles.tierLabel}>オーガナイザー</div>
            {organizers.map((m) => (
              <Chip key={m.id} m={m} kind="top" />
            ))}
          </>
        ) : null}
        {leaders.length > 0 ? (
          <>
            {organizers.length > 0 ? <div className={styles.tierConn} /> : null}
            <div className={`${styles.tierLabel} ${styles.dim}`}>リーダー</div>
            {leaders.map((m) => (
              <Chip key={m.id} m={m} kind="leader" />
            ))}
          </>
        ) : null}
        {plain.length > 0 ? (
          <>
            <div className={`${styles.tierLabel} ${styles.dim}`}>メンバー</div>
            {plain.map((m) => (
              <Chip key={m.id} m={m} kind="sub" />
            ))}
          </>
        ) : null}
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
  // 取りこぼし防止（母集団の一致を保証）: teamIds が空の人だけでなく、実在しないチーム
  // だけを指す(削除済み等)人も、HQにも列にも入らなかった active メンバーを全て拾う。
  // ただし「未所属」を擬似チーム列として生やさず、体制図の下部に控えめな注記として並べる
  // （チーム色・階層を持たせない）。これで 一覧(辞退除く) と 組織図 の母集団は一致しつつ、
  // 存在しないチームを勝手に作らない。
  const unassigned = active.filter((m) => !placed.has(m.id));

  const totalConfirmed = active.filter((m) => m.status === "added").length;
  const totalTent = active.length - totalConfirmed;
  const hqColor = hq?.color ?? HQ_NAVY;

  return (
    <div className={styles.orgChart} data-testid="members-orgchart">
      <div className={styles.orgHead}>
        <div className={styles.orgTitle}>全体組織体制図</div>
        <div className={styles.orgSub}>
          統括チーム → オーガナイザー（チーム長）→ リーダー →（副リーダー・メンバー）の階層
        </div>
        <div className={styles.orgLegend}>
          <span className={styles.li}>
            <span className={styles.legendSw} />
            確定
          </span>
          <span className={styles.li}>
            <span className={`${styles.legendSw} ${styles.tent}`} />
            打診中（淡色・破線）
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
                  const tent = isTentative(m.status);
                  return (
                    <div
                      key={m.id}
                      className={`${styles.namechip} ${lead ? styles.lead : ""}`}
                      data-testid={`members-orgchip-${m.id}`}
                    >
                      {m.name}
                      {tent ? <span className={styles.miniBadge}>{tentBadge(m.status)}</span> : null}
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
                {unassigned.map((m) => (
                  <span key={m.id} className={styles.orgUnassignedName} data-testid={`members-orgchip-${m.id}`}>
                    {m.name}
                    {isTentative(m.status) ? <span className={styles.miniBadge}>{tentBadge(m.status)}</span> : null}
                  </span>
                ))}
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
