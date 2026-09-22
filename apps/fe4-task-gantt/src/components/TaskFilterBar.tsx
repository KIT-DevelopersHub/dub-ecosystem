import type { task, common } from "@dub/types";
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

/** Small funnel glyph so the control reads unambiguously as a filter. */
function FunnelIcon() {
  return (
    <svg className={styles.funnel} width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none">
      <path
        d="M2 3h12l-4.5 5.4V13l-3 1.5V8.4L2 3Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  const toggleStatus = (s: task.TaskStatus) => {
    const has = value.status.includes(s);
    onChange({ ...value, status: has ? value.status.filter((x) => x !== s) : [...value.status, s] });
  };
  const setAssignee = (id: common.UserId | "") => {
    const { assigneeId: _drop, ...rest } = value;
    onChange(id ? { ...rest, assigneeId: id } : rest);
  };
  const activeCount = value.status.length + (value.includeArchived ? 1 : 0) + (value.assigneeId ? 1 : 0);

  return (
    <div className={styles.filterBar} data-testid="fe4-filter-bar" role="group" aria-label="タスクの絞り込み">
      <span className={styles.filterLead}>
        <FunnelIcon />
        <span className={styles.filterLabel}>フィルタ</span>
        {activeCount > 0 && (
          <span className={styles.filterCount} data-testid="fe4-filter-count">
            {activeCount}
          </span>
        )}
      </span>

      <span className={styles.chipGroup}>
        {BOARD_COLUMNS.map((s) => {
          const on = value.status.includes(s);
          return (
            <button
              key={s}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              className={`${styles.chip} ${on ? styles.chipActive : ""}`}
              onClick={() => toggleStatus(s)}
              data-testid={`fe4-filter-status-${s}`}
            >
              {on && <span className={styles.chipCheck} aria-hidden>✓</span>}
              {STATUS_LABEL[s]}
            </button>
          );
        })}
      </span>

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

      <label className={`${styles.chip} ${value.includeArchived ? styles.chipActive : ""}`} data-testid="fe4-filter-archived-label">
        <input
          type="checkbox"
          className={styles.chipCheckbox}
          checked={value.includeArchived}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, includeArchived: e.target.checked })}
          data-testid="fe4-filter-archived"
        />
        アーカイブ含む
      </label>

      {activeCount > 0 && (
        <button
          type="button"
          className={styles.filterClear}
          disabled={disabled}
          onClick={onClear}
          data-testid="fe4-filter-clear"
        >
          クリア
        </button>
      )}
    </div>
  );
}
