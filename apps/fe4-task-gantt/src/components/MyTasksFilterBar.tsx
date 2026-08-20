import type { task, identity, team, common } from "@dub/types";
import { TextField, Select, Button } from "@dub/ui";
import {
  type MyTasksFilter,
  type DueBucket,
  type TaskSort,
  myTasksFilterActiveCount,
} from "../domain/my-tasks";
import { STATUS_LABEL } from "../domain/task-form";
import { BOARD_COLUMNS } from "../domain/status-transitions";
import styles from "../styles/app.module.css";

const DUE_OPTIONS: { value: DueBucket; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "overdue", label: "期限切れ" },
  { value: "today", label: "今日" },
  { value: "week", label: "今週" },
  { value: "none", label: "期限なし" },
];

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: "due", label: "期限が近い順" },
  { value: "priority", label: "優先度が高い順" },
  { value: "updated", label: "更新が新しい順" },
  { value: "created", label: "作成が新しい順" },
  { value: "title", label: "タイトル順" },
];

export interface MyTasksFilterBarProps {
  value: MyTasksFilter;
  onChange: (next: MyTasksFilter) => void;
  onClear: () => void;
  /** roster used to populate the 担当者 / 依頼主 selects. */
  people: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  disabled?: boolean;
}

/**
 * Filter + search + sort for the My Tasks hub (design ask: 情報が乱雑にならない
 * 分かりやすいUI＋フィルタリング). Status/期限 are quick chips; 担当者/依頼主/チーム
 * are selects; sort is a select. All changes flow up via onChange (controlled).
 */
export function MyTasksFilterBar({ value, onChange, onClear, people, teams, disabled }: MyTasksFilterBarProps) {
  const activeCount = myTasksFilterActiveCount(value);
  const personOptions = [
    { value: "", label: "全員" },
    ...people.map((p) => ({ value: p.id, label: p.displayName })),
  ];
  const teamOptions = [{ value: "", label: "全チーム" }, ...teams.map((t) => ({ value: t.id, label: t.name }))];

  const toggleStatus = (s: task.TaskStatus) => {
    const has = value.status.includes(s);
    onChange({ ...value, status: has ? value.status.filter((x) => x !== s) : [...value.status, s] });
  };

  return (
    <div className={styles.myFilterBar} data-testid="fe4-mytasks-filter" role="group" aria-label="タスクの絞り込み">
      <div className={styles.filterRow}>
        <TextField
          id="fe4-mytasks-search"
          value={value.search}
          onChange={(v) => onChange({ ...value, search: v })}
          placeholder="タイトルで検索…"
          disabled={disabled}
          testId="fe4-mytasks-search"
        />
        <label className={styles.selectLabelled}>
          <span className={styles.selectLead}>担当者</span>
          <Select
            id="fe4-mytasks-assignee"
            value={value.assigneeId ?? ""}
            onChange={(v) => onChange({ ...value, assigneeId: v ? (v as common.UserId) : undefined })}
            options={personOptions}
            disabled={disabled}
            testId="fe4-mytasks-assignee"
          />
        </label>
        <label className={styles.selectLabelled}>
          <span className={styles.selectLead}>依頼主</span>
          <Select
            id="fe4-mytasks-requester"
            value={value.requesterId ?? ""}
            onChange={(v) => onChange({ ...value, requesterId: v ? (v as common.UserId) : undefined })}
            options={personOptions}
            disabled={disabled}
            testId="fe4-mytasks-requester"
          />
        </label>
        {teams.length > 0 && (
          <label className={styles.selectLabelled}>
            <span className={styles.selectLead}>チーム</span>
            <Select
              id="fe4-mytasks-team"
              value={value.teamId ?? ""}
              onChange={(v) => onChange({ ...value, teamId: v ? (v as common.TeamId) : undefined })}
              options={teamOptions}
              disabled={disabled}
              testId="fe4-mytasks-team"
            />
          </label>
        )}
        <label className={styles.selectLabelled}>
          <span className={styles.selectLead}>並び替え</span>
          <Select
            id="fe4-mytasks-sort"
            value={value.sort}
            onChange={(v) => onChange({ ...value, sort: v as TaskSort })}
            options={SORT_OPTIONS}
            disabled={disabled}
            testId="fe4-mytasks-sort"
          />
        </label>
      </div>

      <div className={styles.filterRow}>
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
                data-testid={`fe4-mytasks-status-${s}`}
              >
                {on && <span className={styles.chipCheck} aria-hidden>✓</span>}
                {STATUS_LABEL[s]}
              </button>
            );
          })}
        </span>

        <span className={styles.chipGroup} aria-label="期限で絞り込み">
          {DUE_OPTIONS.map((d) => {
            const on = value.due === d.value;
            return (
              <button
                key={d.value}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                className={`${styles.chip} ${on ? styles.chipActive : ""}`}
                onClick={() => onChange({ ...value, due: d.value })}
                data-testid={`fe4-mytasks-due-${d.value}`}
              >
                {d.label}
              </button>
            );
          })}
        </span>

        {activeCount > 0 && (
          <Button variant="ghost" onClick={onClear} disabled={disabled} testId="fe4-mytasks-clear">
            クリア（{activeCount}）
          </Button>
        )}
      </div>
    </div>
  );
}
