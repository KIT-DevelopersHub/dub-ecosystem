// 「運営メンバー・名簿」統合アプリのタブ下本体が読み込み中のスケルトン。
// タブバー(MemberRosterSubnav)はシェル側で永続表示したまま、この本体だけを差し替える。
// FE1 §5 loading principle: 読み込み中は必ずスケルトンを出し、空(データ0件)と区別できるようにする。
import { SkeletonList } from "@dub/ui";
import styles from "./members.module.css";

/** タブ下コンテンツのスケルトン（バーは残したまま本体だけ差し替わる）。 */
export function RosterContentSkeleton(): JSX.Element {
  return (
    <div className={styles.rosterContentSkeleton} data-testid="member-roster-content-skeleton">
      <SkeletonList rows={6} avatar testId="member-roster-skeleton-rows" />
    </div>
  );
}
