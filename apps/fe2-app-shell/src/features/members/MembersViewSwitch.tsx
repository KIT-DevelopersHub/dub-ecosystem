// 運営メンバータブの表示切り替え（カード / 表）と、読み込み中の形に合わせたスケルトン。
import { SegmentedControl, SkeletonCard, SkeletonTable } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import type { MembersView } from "./membersView.ts";
import styles from "./members.module.css";

const VIEW_OPTIONS: SegmentedOption<MembersView>[] = [
  { value: "cards", label: "カード", icon: "users", testId: "members-view-cards" },
  { value: "table", label: "表", icon: "list", testId: "members-view-table" },
];

export function MembersViewSwitch({ value, onChange }: { value: MembersView; onChange: (v: MembersView) => void }): JSX.Element {
  return (
    <div className={styles.viewBar}>
      <SegmentedControl<MembersView>
        options={VIEW_OPTIONS}
        value={value}
        onChange={onChange}
        size="sm"
        aria-label="表示の切り替え"
        testId="members-view-switch"
      />
    </div>
  );
}

/** 表示ごとの読み込み中スケルトン（カードはチーム列の形、表は名簿の行の形）。 */
export function MembersViewSkeleton({ view, testId }: { view: MembersView; testId: string }): JSX.Element {
  if (view === "table") {
    return (
      <div data-testid={testId}>
        <SkeletonTable rows={8} columns={6} />
      </div>
    );
  }
  return (
    <div className={styles.teamGrid} data-testid={testId}>
      {Array.from({ length: 4 }, (_, i) => (
        <SkeletonCard key={i} lines={5} />
      ))}
    </div>
  );
}
