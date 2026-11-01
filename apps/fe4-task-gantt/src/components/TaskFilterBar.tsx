import type { task, common } from "@dub/types";
import { FilterBar, FilterChip, FilterChips } from "@dub/ui";
import type { TaskFilterState } from "../domain/task-query";
import { BOARD_COLUMNS } from "../domain/status-transitions";
import styles from "../styles/app.module.css";

const STATUS_LABEL: Record<task.TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  blocked: "ブロック",
  done: "完了",
  cancelled: "中止",
};

/** One selectable assignee for the 担当者 filter (id + resolved display name). */
export interface AssigneeOption {
  id: common.UserId;
  name: string;
}

export interface TaskFilterBarProps {
  value: TaskFilterState;
  onChange: (next: TaskFilterState) => void;
  onClear: () => void;
  /** Roster ∪ assignees-on-tasks. Empty → the 担当者 selector is hidden. */
  assigneeOptions?: readonly AssigneeOption[];
  disabled?: boolean;
}

/** Status/assignee/archive filter for the gantt. Each control narrows the bars/rows. */
export function TaskFilterBar({ value, onChange, onClear, assigneeOptions = [], disabled }: TaskFilterBarProps) {
  const setAssignee = (id: common.UserId | "") => {
    const { assigneeId: _drop, ...rest } = value;
    onChange(id ? { ...rest, assigneeId: id } : rest);
  };
  const activeCount = value.status.length + (value.includeArchived ? 1 : 0) + (value.assigneeId ? 1 : 0);

  return (
    <FilterBar
      testId="fe4-filter-bar"
      aria-label="タスクの絞り込み"
      activeCount={activeCount}
      activeCountTestId="fe4-filter-count"
      onClear={onClear}
      clearTestId="fe4-filter-clear"
      disabled={disabled}
    >
      <FilterChips
        multiple
        aria-label="ステータスで絞り込み"
        value={value.status}
        onChange={(status) => onChange({ ...value, status })}
        disabled={disabled}
        options={BOARD_COLUMNS.map((s) => ({ value: s, label: STATUS_LABEL[s], testId: `fe4-filter-status-${s}` }))}
      />

      {assigneeOptions.length > 0 && (
        <label
          className={`${styles.filterSelect} ${value.assigneeId ? styles.filterSelectActive : ""}`}
          data-testid="fe4-filter-assignee-label"
        >
          <span className={styles.filterSelectLabel}>担当者</span>
          <select
            className={styles.filterSelectInput}
            value={value.assigneeId ?? ""}
            disabled={disabled}
            onChange={(e) => setAssignee(e.target.value)}
            aria-label="担当者で絞り込む"
            data-testid="fe4-filter-assignee"
          >
            <option value="">全員</option>
            {assigneeOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <FilterChip
        selected={value.includeArchived}
        onToggle={() => onChange({ ...value, includeArchived: !value.includeArchived })}
        disabled={disabled}
        testId="fe4-filter-archived"
      >
        アーカイブ含む
      </FilterChip>
    </FilterBar>
  );
}
