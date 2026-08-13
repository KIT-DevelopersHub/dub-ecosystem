// チーム別ビュー: one Card per team, members grouped under it. Also surfaces members
// not assigned to any team, and per-team edit/delete.
import { Card, Badge, IconButton, EmptyState } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import { MemberStatusBadge } from "./MemberStatusBadge.tsx";
import styles from "./members.module.css";

function MemberRow({
  m,
  onEdit,
  onDelete,
}: {
  m: OrgMember;
  onEdit: (m: OrgMember) => void;
  onDelete: (m: OrgMember) => void;
}): JSX.Element {
  return (
    <div className={styles.memberRow} data-testid={`members-teamrow-${m.id}`}>
      <div className={styles.memberMain}>
        <span className={styles.memberName}>{m.name}</span>
        {m.roleTitle ? <span className={styles.memberRole}>{m.roleTitle}</span> : null}
        {m.department || m.grade ? (
          <span className={styles.memberRole}>{[m.department, m.grade].filter(Boolean).join(" ")}</span>
        ) : null}
      </div>
      <MemberStatusBadge status={m.status} />
      <div className={styles.rowSpacer} />
      <div className={styles.rowActions}>
        <IconButton name="edit" aria-label={`${m.name} を編集`} onClick={() => onEdit(m)} />
        <IconButton name="trash" aria-label={`${m.name} を削除`} variant="danger" onClick={() => onDelete(m)} />
      </div>
    </div>
  );
}

export function TeamsView({
  teams,
  members,
  onEditMember,
  onDeleteMember,
  onEditTeam,
  onDeleteTeam,
}: {
  teams: MemberTeam[];
  members: OrgMember[];
  onEditMember: (m: OrgMember) => void;
  onDeleteMember: (m: OrgMember) => void;
  onEditTeam: (t: MemberTeam) => void;
  onDeleteTeam: (t: MemberTeam) => void;
}): JSX.Element {
  const unassigned = members.filter((m) => m.teamIds.length === 0);

  if (teams.length === 0) {
    return <EmptyState title="チームがありません" description="「チームを追加」から作成してください" icon="users" />;
  }

  return (
    <div className={styles.teamGrid}>
      {teams.map((team) => {
        const inTeam = members.filter((m) => m.teamIds.includes(team.id));
        return (
          <Card
            key={team.id}
            testId={`members-teamcard-${team.id}`}
            header={
              <div className={styles.teamHeader}>
                {team.color ? <span className={styles.colorDot} style={{ background: team.color }} aria-hidden /> : null}
                <span className={styles.teamName}>{team.name}</span>
                <Badge tone="neutral">{inTeam.length}</Badge>
                <div className={styles.teamActions}>
                  <IconButton name="edit" aria-label={`${team.name} を編集`} onClick={() => onEditTeam(team)} />
                  <IconButton name="trash" aria-label={`${team.name} を削除`} variant="danger" onClick={() => onDeleteTeam(team)} />
                </div>
              </div>
            }
          >
            {inTeam.length === 0 ? (
              <p className={styles.emptyTeamNote}>メンバー未割り当て</p>
            ) : (
              inTeam.map((m) => <MemberRow key={m.id} m={m} onEdit={onEditMember} onDelete={onDeleteMember} />)
            )}
          </Card>
        );
      })}

      {unassigned.length > 0 ? (
        <Card testId="members-teamcard-unassigned" header={<div className={styles.teamHeader}><span className={styles.teamName}>未所属</span><Badge tone="warning">{unassigned.length}</Badge></div>}>
          {unassigned.map((m) => (
            <MemberRow key={m.id} m={m} onEdit={onEditMember} onDelete={onDeleteMember} />
          ))}
        </Card>
      ) : null}
    </div>
  );
}
