import { useEffect, useRef } from "react";
import type { common, identity, task, team } from "@dub/types";
import { TextField, Textarea, Select } from "@dub/ui";
import { PRIORITY_LABEL, STATUS_LABEL, DATE_LABEL } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker } from "./PredecessorPicker";
import { AssigneePicker } from "./AssigneePicker";
import { ASSIGNEE_REQUIRED_MESSAGE, deriveTaskTeam, hasAssignee, type Assignee } from "../domain/assignee";
import { useUserTeams } from "../api/useUserTeams";
import styles from "../styles/app.module.css";

/**
 * Shared task-form body — the ONE canonical field set/order/2-column layout used by
 * BOTH create forms (タスク発行 MyTaskCreateModal / タスク作成 TaskCreateModal), so the
 * two never drift apart again (ユーザー確定レイアウト・共通コンポーネント化):
 *
 *   タイトル                （全幅）
 *   ステータス   重要度      （2カラム・同一行）
 *   担当 *                  （全幅・必須: 人 or チーム。未割当は選べない）
 *   開始日       終了日      （2カラム・同一行）
 *   親タスク                （全幅）
 *   先行タスク              （全幅）
 *   詳細                    （全幅）
 *
 * Each 2-column pair is a `.formRow` (spans the grid full-width, then auto-fits its two
 * children side-by-side at normal width; wraps only at very narrow widths). Full-width
 * fields are `.formFieldFull`. Presentational: all state lives in the parent modal.
 *
 * チーム (teamId) is NOT an input (ユーザー確定: 担当と同じ名前が二重に出るため撤去). It is still
 * sent and owned here: it follows the 担当 (deriveTaskTeam — チーム担当ならそのチーム・人なら
 * その人の所属チーム), and choosing a 親タスク fixes it to the parent's team (親子は同一チーム・
 * the server also enforces it) — while a parent is set, the 担当 does not move it. Cross-team
 * predecessors are pruned whenever it changes.
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
  /** 担当 = 人 XOR チーム (#882). 必須 — the picker has no 未割当; while both are null an
   *  inline error shows and the parent modal keeps its submit disabled (hasAssignee). */
  assigneeId: common.UserId | null;
  onAssigneeChange: (v: common.UserId | null) => void;
  assigneeTeamId: common.TeamId | null;
  onAssigneeTeamIdChange: (v: common.TeamId | null) => void;

  /** team list (担当のチーム候補・所属チームの優先順). */
  teams: readonly team.Team[];
  /** the task's team — not shown; derived from 担当 / 親タスク (see above). */
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
    assigneeTeamId,
    onAssigneeTeamIdChange,
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

  const assigneeMissing = !hasAssignee({ assigneeId, assigneeTeamId });
  const depOptions = dependencyScopeOptions(scopeTasks, teamId);
  const teamLockedToParent = parentId != null;
  const userTeams = useUserTeams();

  const handleTeamChange = (next: common.TeamId | null) => {
    onTeamIdChange(next);
    // dependencies are same-team only — drop predecessors that fall out of scope.
    onDepsChange(pruneToScope(scopeTasks, next, deps));
  };

  const followAssignee = (next: Assignee) => {
    if (teamLockedToParent) return; // 親子は同一チーム wins
    const derived = deriveTaskTeam(next, teamId, userTeams, teams.map((t) => t.id));
    if (derived !== teamId) handleTeamChange(derived);
  };

  // The 所属 lookup arrives async: re-derive once it lands (e.g. a restored draft's 担当).
  const derivedFor = useRef<typeof userTeams | null>(null);
  useEffect(() => {
    if (userTeams.size === 0 || derivedFor.current === userTeams) return;
    derivedFor.current = userTeams;
    if (assigneeId) followAssignee({ assigneeId, assigneeTeamId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userTeams]);

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

      {/* ステータス / 重要度 (2カラム・同一行) */}
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
            重要度
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

      {/* 担当 (全幅・必須)。チームは担当に従う（入力欄は出さない） */}
      <div className={styles.formFieldFull}>
        <label className={styles.formLabel} htmlFor={`${idPrefix}-assignee`}>
          担当<span className={styles.req}>*</span>
        </label>
        <AssigneePicker
          id={`${idPrefix}-assignee`}
          users={users}
          teams={teams}
          value={{ assigneeId, assigneeTeamId }}
          invalid={assigneeMissing}
          aria-describedby={assigneeMissing ? `${idPrefix}-assignee-error` : undefined}
          onChange={(next) => {
            onAssigneeChange(next.assigneeId);
            onAssigneeTeamIdChange(next.assigneeTeamId);
            followAssignee(next);
          }}
          testId={`${idPrefix}-assignee`}
        />
        {assigneeMissing && (
          <span id={`${idPrefix}-assignee-error`} className={styles.fieldError} role="alert" data-testid={`${idPrefix}-assignee-error`}>
            {ASSIGNEE_REQUIRED_MESSAGE}
          </span>
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
