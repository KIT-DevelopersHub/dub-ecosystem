import type { common } from "@dub/types";
import { TaskSearchSelect, type TaskSearchOption } from "@dub/app-ui";

export type PredecessorOption = TaskSearchOption<common.TaskId>;

export interface PredecessorPickerProps {
  options: readonly PredecessorOption[];
  value: readonly common.TaskId[];
  onChange: (next: common.TaskId[]) => void;
  /** When provided, each selected chip gets a 「親に」 action to convert that
   *  predecessor (依存) into the task's parent (親子) — relation-type switching. */
  onPromoteToParent?: (id: common.TaskId) => void;
  testId?: string;
}

/**
 * Searchable predecessor (先行タスク＝依存) picker. A thin FE4 wrapper over the
 * shared @dub/app-ui `TaskSearchSelect` core (multi mode) — the same core also
 * backs the 親タスク search, so both stay in lockstep. Focus opens the full list
 * of same-scope candidates (scrollable); typing narrows it. Keeps the existing
 * props so every call site / test is unchanged.
 */
export function PredecessorPicker({ options, value, onChange, onPromoteToParent, testId }: PredecessorPickerProps) {
  return (
    <TaskSearchSelect<common.TaskId>
      multiple
      options={options}
      value={value}
      onChange={onChange}
      emptyOptionsLabel="先行にできるタスクがありません"
      placeholder="タスク名で検索・一覧から選択…"
      testId={testId}
      {...(onPromoteToParent
        ? {
            chipAction: {
              label: "親に",
              title: (o: PredecessorOption) => `「${o.title}」を親タスク（親子）に変換`,
              onAct: onPromoteToParent,
            },
          }
        : {})}
    />
  );
}
