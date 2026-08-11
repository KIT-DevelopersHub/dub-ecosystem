// 組織図ビュー: the hierarchical team → member view that replaces the hand-made PDF.
// Read-only, print/PNG-friendly (window.print with a print stylesheet). Deliberately
// simple (no graph lib): a titled block per team with member cards + status.
import { Avatar, Badge } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";
import styles from "./members.module.css";

function OrgMemberCard({ m }: { m: OrgMember }): JSX.Element {
  return (
    <div className={styles.orgCard} data-testid={`members-orgcard-${m.id}`}>
      <Avatar name={m.name} size="sm" />
      <div className={styles.orgCardMain}>
        <span className={styles.memberName}>{m.name}</span>
        {m.roleTitle ? <span className={styles.memberRole}>{m.roleTitle}</span> : null}
      </div>
      <MemberStatusBadge status={m.status} />
    </div>
  );
}

export function OrgChartView({ teams, members }: { teams: MemberTeam[]; members: OrgMember[] }): JSX.Element {
  const unassigned = members.filter((m) => m.teamIds.length === 0);

  return (
    <div className={styles.orgRoot} data-testid="members-orgchart">
      {teams.map((team) => {
        const inTeam = members.filter((m) => m.teamIds.includes(team.id));
        return (
          <div key={team.id} className={styles.orgTeam}>
            <div className={styles.orgTeamTitle}>
              {team.color ? <span className={styles.colorDot} style={{ background: team.color }} aria-hidden /> : null}
              <span>{team.name}</span>
              <Badge tone="neutral">{inTeam.length}</Badge>
            </div>
            {inTeam.length === 0 ? (
              <p className={styles.emptyTeamNote}>メンバー未割り当て</p>
            ) : (
              <div className={styles.orgMembers}>
                {inTeam.map((m) => (
                  <OrgMemberCard key={m.id} m={m} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {unassigned.length > 0 ? (
        <div className={styles.orgTeam}>
          <div className={styles.orgTeamTitle}>
            <span>未所属</span>
            <Badge tone="warning">{unassigned.length}</Badge>
          </div>
          <div className={styles.orgMembers}>
            {unassigned.map((m) => (
              <OrgMemberCard key={m.id} m={m} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
