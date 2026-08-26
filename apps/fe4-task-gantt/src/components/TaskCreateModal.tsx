import { useEffect, useMemo, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Select } from "@dub/ui";
import { PRIORITY_LABEL, STATUS_LABEL, isoFromDateInput } from "../domain/task-form";
import { dependencyScopeOptions, pruneToScope, teamOf, type ScopeTask } from "../domain/task-hierarchy";
import { DateField } from "./DateField";
import { PredecessorPicker, rememberPredecessors } from "./PredecessorPicker";
import styles from "../styles/app.module.css";

export interface TaskDraft {
  title: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  startAt: common.ISODateTime | null;
  dueAt: common.ISODateTime | null;
  /** WBS parent (親タスク). null = top-level. Chosen before the predecessors. */
  parentTaskId: common.TaskId | null;
  dependsOnIds: common.TaskId[];
}

export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  users: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks in the event, offered as WBS parents (親タスク). */
  parentOptions: readonly { id: common.TaskId; title: string }[];
  /** every task in the event with its team — predecessors are scoped to the chosen
   *  team (ADR-0007: 同一チーム内なら別スコープ/別階層も依存可・別チームは不可). */
  scopeTasks: readonly ScopeTask[];
  /** Resolves `false` when the task was NOT created (keep the modal open so the
   *  user can fix + retry); `true`/void on success (modal closes). */
  onCreate: (draft: TaskDraft) => Promise<boolean | void>;
  /** date-input value (YYYY-MM-DD) preset when opened from a timeline cell. */
  initialDue?: string | null;
  /** parent id preset when opened via "ここから子タスクを作成". */
  initialParentId?: common.TaskId | null;
  /** predecessor ids preset when opened with a dependency already in mind. */
  initialDependsOn?: readonly common.TaskId[];
}

// A newly-created task starts in "todo"; only todo-reachable states are offered.
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export function TaskCreateModal({ open, onClose, users, teams, parentOptions, scopeTasks, onCreate, initialDue, initialParentId, initialDependsOn }: TaskCreateModalProps) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [parentId, setParentId] = useState<common.TaskId | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [saving, setSaving] = useState(false);

  // Predecessors are scoped to the chosen TEAM (ADR-0007): same-team tasks across any
  // hierarchy level are offered; other teams are excluded (their work goes through the
  // request/approval flow). Recomputes whenever the team changes.
  const depOptions = useMemo(() => dependencyScopeOptions(scopeTasks, teamId), [scopeTasks, teamId]);

  // 親子は同一チーム: 親を選んだ子タスクは親のチームに固定する。チーム欄は親のチームで
  // プリフィルし、親がいる間は変更不可（disabled）にして、親子でチームが食い違う状態を
  // 作らせない（サーバも 422 TASK_PARENT_CHILD_TEAM_MISMATCH で担保）。親なし＝自由。
  const teamLockedToParent = parentId != null;

  // seed the due date + parent + predecessors when (re)opened (timeline cell /
  // "ここから子タスクを作成" preset the parent, etc.). 親をプリセットで開いたときは
  // チームも親のチームで固定する。
  useEffect(() => {
    if (open) {
      setDue(initialDue ?? null);
      const nextParent = initialParentId ?? null;
      setParentId(nextParent);
      if (nextParent) setTeamId(teamOf(scopeTasks, nextParent));
      setDeps(initialDependsOn ? [...initialDependsOn] : []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDue, initialParentId, initialDependsOn]);

  const reset = () => {
    setTitle("");
    setStatus("todo");
    setPriority("medium");
    setAssigneeId(null);
    setTeamId(null);
    setStart(null);
    setDue(null);
    setParentId(null);
    setDeps([]);
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const ok = await onCreate({
        title: title.trim(),
        status,
        priority,
        assigneeId,
        // 子タスク作成時はチームを親に固定（UIは disabled だが念のため送信値も親で確定）。
        teamId: parentId ? teamOf(scopeTasks, parentId) : teamId,
        startAt: isoFromDateInput(start),
        dueAt: isoFromDateInput(due),
        parentTaskId: parentId,
        dependsOnIds: deps,
      });
      // Close ONLY on success — a failed create keeps the form (with its input) open
      // so the user can retry after reading the error dialog. Success shows a toast.
      if (ok !== false) {
        rememberPredecessors(deps);
        reset();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="タスクを作成"
      testId="fe4-create-modal"
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" onClick={close} testId="fe4-create-cancel">
            キャンセル
          </Button>
          <Button onClick={submit} loading={saving} disabled={!title.trim()} testId="fe4-create-submit">
            作成する
          </Button>
        </div>
      }
    >
      <div className={styles.formGrid}>
        <div className={styles.formFieldFull}>
          <label className={styles.formLabel} htmlFor="fe4-create-title">
            タイトル<span className={styles.req}>*</span>
          </label>
          <TextField
            id="fe4-create-title"
            value={title}
            onChange={setTitle}
            placeholder="例: 会場の最終確認"
            testId="fe4-create-title"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-create-status">
            ステータス
          </label>
          <Select
            id="fe4-create-status"
            value={status}
            onChange={(v) => setStatus(v as task.TaskStatus)}
            options={CREATE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            testId="fe4-create-status"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-create-priority">
            優先度
          </label>
          <Select
            id="fe4-create-priority"
            value={priority}
            onChange={(v) => setPriority(v as task.TaskPriority)}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
            testId="fe4-create-priority"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-create-assignee">
            担当
          </label>
          <Select
            id="fe4-create-assignee"
            value={assigneeId ?? ""}
            onChange={(v) => setAssigneeId(v ? (v as common.UserId) : null)}
            options={[{ value: "", label: "未割当" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
            testId="fe4-create-assignee"
          />
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-create-start">
              開始日
            </label>
            <DateField id="fe4-create-start" value={start} onChange={setStart} testId="fe4-create-start" />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-create-due">
              終了日
            </label>
            <DateField id="fe4-create-due" value={due} onChange={setDue} testId="fe4-create-due" />
          </div>
        </div>

        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-create-team">
              チーム
            </label>
            <Select
              id="fe4-create-team"
              value={teamId ?? ""}
              disabled={teamLockedToParent}
              onChange={(v) => {
                const next = v ? (v as common.TeamId) : null;
                setTeamId(next);
                // dependencies are same-team only — drop predecessors on other teams.
                setDeps((d) => pruneToScope(scopeTasks, next, d));
              }}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId="fe4-create-team"
            />
            {teamLockedToParent && (
              <p className={styles.fieldHint} data-testid="fe4-create-team-locked">
                親タスクと同じチームになります（変更できません）
              </p>
            )}
          </div>
        )}

        {/* 親タスク → then 先行タスク: choose the WBS parent, then dependencies.
            Predecessors are limited to the chosen TEAM (any hierarchy level, ADR-0007). */}
        <div className={styles.formFieldFull}>
          <label className={styles.formLabel} htmlFor="fe4-create-parent">
            親タスク（任意・未選択でトップレベル）
          </label>
          <Select
            id="fe4-create-parent"
            value={parentId ?? ""}
            onChange={(v) => {
              const next = v ? (v as common.TaskId) : null;
              setParentId(next);
              // 親子は同一チーム: 親を選んだらチームを親のチームへ合わせる（親子でチームが
              // 食い違う状態を作らせない）。トップレベルへ戻す（next=null）ならチームは維持。
              const parentTeam = next ? teamOf(scopeTasks, next) : teamId;
              if (next) setTeamId(parentTeam);
              // deps are team-scoped (ADR-0007): re-scope predecessors to the (parent's) team.
              setDeps((d) => pruneToScope(scopeTasks, parentTeam, d));
            }}
            options={[{ value: "", label: "なし（トップレベル）" }, ...parentOptions.map((o) => ({ value: o.id, label: o.title }))]}
            testId="fe4-create-parent"
          />
        </div>

        <div className={styles.formFieldFull}>
          <span className={styles.formLabel}>先行タスク（依存・同じチーム内のタスク）</span>
          <PredecessorPicker options={depOptions} value={deps} onChange={setDeps} testId="fe4-create-deps" />
        </div>
      </div>
    </Modal>
  );
}
