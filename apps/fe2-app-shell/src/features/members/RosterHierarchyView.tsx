// 運営名簿の「階層で見る」(#873): 上段にオーガナイザーを横並び、下段にリーダーを横並びにし、
// 各リーダーの下へ配下メンバーを縦に並べる。リーダー未設定の人は末尾の別列。
// 狭い画面では横スクロール(ページ本体はスクロールしない)。カードのクリックで編集を開く
// (閲覧のみでは押せない。表で見るの行クリックと同じ)。
import { EmptyState, Tag } from "@dub/ui";
import type { MemberTeam, OrgMember } from "./contracts.ts";
import type { RosterHierarchy } from "./rosterHierarchy.ts";
import styles from "./members.module.css";

function PersonCard({
  m,
  teamsById,
  onOpen,
  muted = false,
}: {
  m: OrgMember;
  teamsById: Map<string, MemberTeam>;
  onOpen?: ((m: OrgMember) => void) | undefined;
  muted?: boolean;
}): JSX.Element {
  const body = (
    <>
      <span className={styles.personName}>{m.name}</span>
      <span className={styles.personRole}>{m.roleTitle?.trim() || "—"}</span>
      {m.teamIds.length > 0 ? (
        <span className={styles.personTeams}>
          {m.teamIds.map((id) => (
            <Tag key={id} tone="brand">
              {teamsById.get(id)?.name ?? "?"}
            </Tag>
          ))}
        </span>
      ) : null}
    </>
  );
  const common = { className: styles.personCard, "data-muted": muted || undefined, "data-testid": `member-roster-card-${m.id}` };
  return onOpen ? (
    <button type="button" {...common} onClick={() => onOpen(m)} aria-label={`${m.name} を編集`}>
      {body}
    </button>
  ) : (
    <div {...common}>{body}</div>
  );
}

export function RosterHierarchyView({
  hierarchy,
  teamsById,
  onOpen,
}: {
  hierarchy: RosterHierarchy;
  teamsById: Map<string, MemberTeam>;
  /** 省略時(閲覧のみ)はカードを押せない。 */
  onOpen?: (m: OrgMember) => void;
}): JSX.Element {
  const { organizers, leaders, unassigned } = hierarchy;
  if (organizers.length === 0 && leaders.length === 0 && unassigned.length === 0) {
    return <EmptyState title="該当するメンバーはいません" description="検索や絞り込みの条件を変えてください" testId="member-roster-hierarchy-empty" />;
  }
  return (
    <div className={styles.hierarchyScroll} data-testid="member-roster-hierarchy">
      <div className={styles.hierarchy}>
        {organizers.length > 0 ? (
          <section className={styles.hierarchyTier} aria-label="オーガナイザー" data-testid="member-roster-tier-organizer">
            <h3 className={styles.hierarchyTierTitle}>オーガナイザー</h3>
            <div className={styles.hierarchyRow}>
              {organizers.map((m) => (
                <PersonCard key={m.id} m={m} teamsById={teamsById} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ) : null}
        {leaders.length > 0 || unassigned.length > 0 ? (
          <section className={styles.hierarchyTier} aria-label="リーダーとメンバー" data-testid="member-roster-tier-leader">
            <h3 className={styles.hierarchyTierTitle}>リーダーとメンバー</h3>
            <div className={styles.hierarchyRow}>
              {leaders.map((col) => (
                <div key={col.leader.id} className={styles.leaderColumn} data-testid={`member-roster-column-${col.leader.id}`}>
                  <PersonCard m={col.leader} teamsById={teamsById} onOpen={onOpen} muted={!col.leaderVisible} />
                  {col.members.length > 0 ? (
                    <div className={styles.columnMembers}>
                      {col.members.map((m) => (
                        <PersonCard key={m.id} m={m} teamsById={teamsById} onOpen={onOpen} />
                      ))}
                    </div>
                  ) : (
                    <p className={styles.columnEmpty}>メンバーなし</p>
                  )}
                </div>
              ))}
              {unassigned.length > 0 ? (
                <div className={styles.leaderColumn} data-testid="member-roster-column-unassigned">
                  <div className={styles.unassignedColumnHead}>リーダー未設定</div>
                  <div className={styles.columnMembers}>
                    {unassigned.map((m) => (
                      <PersonCard key={m.id} m={m} teamsById={teamsById} onOpen={onOpen} />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
