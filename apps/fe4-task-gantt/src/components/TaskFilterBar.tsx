import type { task } from "@dub/types";
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

export interface TaskFilterBarProps {
  value: TaskFilterState;
  onChange: (next: TaskFilterState) => void;
  disabled?: boolean;
}

/** Shared by all three views; parent syncs `value` to the URL query. */
export function TaskFilterBar({ value, onChange, disabled }: TaskFilterBarProps) {
  const toggleStatus = (s: task.TaskStatus) => {
    const has = value.status.includes(s);
    onChange({ ...value, status: has ? value.status.filter((x) => x !== s) : [...value.status, s] });
  };
  return (
    <div className={styles.filterBar} data-testid="fe4-filter-bar">
      {BOARD_COLUMNS.map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          className={`${styles.chip} ${value.status.includes(s) ? styles.chipActive : ""}`}
          onClick={() => toggleStatus(s)}
          data-testid={`fe4-filter-status-${s}`}
        >
          {STATUS_LABEL[s]}
        </button>
      ))}
      <label className={styles.chip}>
        <input
          type="checkbox"
          checked={value.includeArchived}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, includeArchived: e.target.checked })}
          data-testid="fe4-filter-archived"
        />{" "}
        アーカイブ含む
      </label>
    </div>
  );
}
