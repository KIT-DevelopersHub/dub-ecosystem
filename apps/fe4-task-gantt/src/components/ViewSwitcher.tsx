import { SegmentedControl } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";

export type TaskView = "list" | "board" | "gantt";

// List / board / gantt switch, built on the shared @dub/ui SegmentedControl
// (sliding-pill selector) instead of a hand-rolled tablist — see
// docs/segmented-control-unification.md. A thin wrapper keeps the TaskView-typed
// value + onChange and the fe4-view-* testids that callers/tests rely on.
const OPTIONS: SegmentedOption<TaskView>[] = [
  { value: "list", label: "一覧", testId: "fe4-view-list" },
  { value: "board", label: "ボード", testId: "fe4-view-board" },
  { value: "gantt", label: "ガント", testId: "fe4-view-gantt" },
];

export function ViewSwitcher({ value, onChange }: { value: TaskView; onChange: (v: TaskView) => void }) {
  return (
    <SegmentedControl
      options={OPTIONS}
      value={value}
      onChange={onChange}
      aria-label="表示切替"
      testId="fe4-view-switcher"
    />
  );
}
