import type { common, identity, task, team } from "@dub/types";
import { TextField, Textarea, Select } from "@dub/ui";
import { PRIORITY_LABEL, STATUS_LABEL, DATE_LABEL } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker } from "./PredecessorPicker";
import styles from "../styles/app.module.css";

/**
 * Shared task-form body — the ONE canonical field set/order/2-column layout used by
 * BOTH create forms (タスク発行 MyTaskCreateModal / タスク作成 TaskCreateModal), so the
 * two never drift apart again (ユーザー確定レイアウト・共通コンポーネント化):
 *
 *   タイトル                （全幅）
 *   ステータス   優先度      （2カラム・同一行）
 *   担当         チーム      （2カラム・同一行）
 *   開始日       終了日      （2カラム・同一行）
 *   親タスク                （全幅）
 *   先行タスク              （全幅）
 *   詳細                    （全幅）
 *
 * Each 2-column pair is a `.formRow` (spans the grid full-width, then auto-fits its two
 * children side-by-side at normal width; wraps only at very narrow widths). Full-width
 * fields are `.formFieldFull`. Presentational: all state lives in the parent modal.
 *
 * The 親タスク→チーム interlock (親子は同一チーム) is owned here so both forms behave
 * identically: choosing a 親タスク fixes+locks the team to the parent's team and prunes
 * cross-team predecessors; the server also enforces it (二重の担保).
 *
 * This component takes NO per-form escape hatches (no extra slots, no relabeling): the
 * field set/order is the single canonical spec and both create modals render it with the
 * SAME props, so タスク作成 と タスク発行 は寸分違わず同一になる (フォーム固有の追加項目は作らない).
 */
export interface TaskFormFieldsProps {
  idPrefix: string;

  title: string;
  onTitleChange: (v: string) => void;
  titlePlaceholder?: string;

  statuses: readonly task.TaskStatus[];
  status: task.TaskStatus;
  onStatusChange: (v: task.TaskStatus) => void;

  priorities: readonly task.TaskPriority[];
  priority: task.TaskPriority;
  onPriorityChange: (v: task.TaskPriority) => void;

  users: readonly identity.UserSummary[];
  assigneeId: common.UserId | null;
  onAssigneeChange: (v: common.UserId | null) => void;

  teams: readonly team.Team[];
  teamId: common.TeamId | null;
  onTeamIdChange: (v: common.TeamId | null) => void;

  start: string | null;
  onStartChange: (v: string | null) => void;
  due: string | null;
  onDueChange: (v: string | null) => void;

  /** every task in scope with its team — powers the 親タスク select and the team-scoped
   *  先行タスク picker (ADR-0007: same-team only). */
  scopeTasks: readonly ScopeTask[];
  /** existing tasks offered as WBS parents (親タスク). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  parentId: common.TaskId | null;
  onParentIdChange: (v: common.TaskId | null) => void;
  deps: readonly common.TaskId[];
  onDepsChange: (next: common.TaskId[]) => void;

  description: string;
  onDescriptionChange: (v: string) => void;
  descriptionPlaceholder?: string;
}

export function TaskFormFields(props: TaskFormFieldsProps) {
  const {
    idPrefix,
    title,
    onTitleChange,
    titlePlaceholder,
    statuses,
    status,
    onStatusChange,
    priorities,
    priority,
    onPriorityChange,
    users,
    assigneeId,
    onAssigneeChange,
    teams,
    teamId,
    onTeamIdChange,
    start,
    onStartChange,
    due,
    onDueChange,
    scopeTasks,
    parentOptions,
    parentId,
    onParentIdChange,
    deps,
    onDepsChange,
    description,
    onDescriptionChange,
    descriptionPlaceholder,
  } = props;

  const depOptions = dependencyScopeOptions(scopeTasks, teamId);
  const teamLockedToParent = parentId != null;

  const handleTeamChange = (next: common.TeamId | null) => {
    onTeamIdChange(next);
    // dependencies are same-team only — drop predecessors that fall out of scope.
    onDepsChange(pruneToScope(scopeTasks, next, deps));
  };

  const handleParentChange = (next: common.TaskId | null) => {
    onParentIdChange(next);
    // 親子は同一チーム: fix the team to the parent's team; keep team on detach to top-level.
    const parentTeam = next ? teamOf(scopeTasks, next) : teamId;
    if (next) onTeamIdChange(parentTeam);
    onDepsChange(pruneToScope(scopeTasks, parentTeam, deps));
  };

  return (
    <div className={styles.formGrid} data-form-spec="fe4-taskform-identical-v2">
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel} htmlFor={`${idPrefix}-title`}>
          タイトル<span className={styles.req}>*</span>
        </label>
        <TextField
          id={`${idPrefix}-title`}
          value={title}
          onChange={onTitleChange}
          placeholder={titlePlaceholder}
          testId={`${idPrefix}-title`}
        />
      </div>

      {/* ステータス / 優先度 (2カラム・同一行) */}
      <div className={styles.formRow}>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idPrefix}-status`}>
            ステータス
          </label>
          <Select
            id={`${idPrefix}-status`}
            value={status}
            onChange={(v) => onStatusChange(v as task.TaskStatus)}
            options={statuses.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            testId={`${idPrefix}-status`}
          />
        </div>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idPrefix}-priority`}>
            優先度
          </label>
          <Select
            id={`${idPrefix}-priority`}
            value={priority}
            onChange={(v) => onPriorityChange(v as task.TaskPriority)}
            options={priorities.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            testId={`${idPrefix}-priority`}
          />
        </div>
      </div>

      {/* 担当 / チーム (2カラム・同一行) */}
      <div className={styles.formRow}>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idPrefix}-assignee`}>
            担当
          </label>
          <Select
            id={`${idPrefix}-assignee`}
            value={assigneeId ?? ""}
            onChange={(v) => onAssigneeChange(v ? (v as common.UserId) : null)}
            options={[{ value: "", label: "未割当" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
            testId={`${idPrefix}-assignee`}
          />
        </div>
        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor={`${idPrefix}-team`}>
              チーム
            </label>
            <Select
              id={`${idPrefix}-team`}
              value={teamId ?? ""}
              disabled={teamLockedToParent}
              onChange={(v) => handleTeamChange(v ? (v as common.TeamId) : null)}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId={`${idPrefix}-team`}
            />
            {teamLockedToParent && (
              <p className={styles.fieldHint} data-testid={`${idPrefix}-team-locked`}>
                親タスクと同じチームになります（変更できません）
              </p>
            )}
          </div>
        )}
      </div>

      {/* 開始日 / 終了日 (2カラム・同一行) */}
      <div className={styles.formRow}>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idPrefix}-start`}>
            {DATE_LABEL.start}
          </label>
          <DateField id={`${idPrefix}-start`} value={start} onChange={onStartChange} testId={`${idPrefix}-start`} />
        </div>
        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`${idPrefix}-due`}>
            {DATE_LABEL.end}
          </label>
          <DateField id={`${idPrefix}-due`} value={due} onChange={onDueChange} testId={`${idPrefix}-due`} />
        </div>
      </div>

      {/* 親タスク (全幅) */}
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel} htmlFor={`${idPrefix}-parent`}>
          親タスク（任意・未選択でトップレベル）
        </label>
        <Select
          id={`${idPrefix}-parent`}
          value={parentId ?? ""}
          onChange={(v) => handleParentChange(v ? (v as common.TaskId) : null)}
          options={[{ value: "", label: "なし（トップレベル）" }, ...parentOptions.map((o) => ({ value: o.id, label: o.title }))]}
          testId={`${idPrefix}-parent`}
        />
      </div>

      {/* 先行タスク (全幅) */}
      <div className={styles.formFieldFull}>
        <span className={styles.formLabel}>先行タスク（依存・同じチーム内のタスク）</span>
        <PredecessorPicker options={depOptions} value={deps} onChange={onDepsChange} testId={`${idPrefix}-deps`} />
      </div>

      {/* 詳細 (全幅) */}
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel} htmlFor={`${idPrefix}-desc`}>
          詳細（任意）
        </label>
        <Textarea
          id={`${idPrefix}-desc`}
          value={description}
          onChange={onDescriptionChange}
          rows={3}
          placeholder={descriptionPlaceholder}
          testId={`${idPrefix}-desc`}
        />
      </div>
    </div>
  );
}
