import { useEffect, useState } from "react";
import type { common, identity, task, team } from "@dub/types";
import { Modal, Button, TextField, Select } from "@dub/ui";
import { PRIORITY_LABEL, STATUS_LABEL, isoFromDateInput } from "../domain/task-form";
import { DateField } from "./DateField";
import { PredecessorPicker, rememberPredecessors } from "./PredecessorPicker";
import styles from "../styles/app.module.css";

export interface TaskDraft {
  title: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  dueAt: common.ISODateTime | null;
  dependsOnIds: common.TaskId[];
}

export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  users: readonly identity.UserSummary[];
  teams: readonly team.Team[];
  /** existing tasks in the event, offered as predecessors (dependencies). */
  dependencyOptions: readonly { id: common.TaskId; title: string }[];
  onCreate: (draft: TaskDraft) => Promise<void>;
  /** date-input value (YYYY-MM-DD) preset when opened from a timeline cell. */
  initialDue?: string | null;
  /** predecessor ids preset when opened via "create child task" (feature #4). */
  initialDependsOn?: readonly common.TaskId[];
}

// A newly-created task starts in "todo"; only todo-reachable states are offered.
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export function TaskCreateModal({ open, onClose, users, teams, dependencyOptions, onCreate, initialDue, initialDependsOn }: TaskCreateModalProps) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [teamId, setTeamId] = useState<common.TeamId | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [saving, setSaving] = useState(false);

  // seed the due date + predecessors when (re)opened from a timeline cell / child-create.
  useEffect(() => {
    if (open) {
      setDue(initialDue ?? null);
      setDeps(initialDependsOn ? [...initialDependsOn] : []);
    }
  }, [open, initialDue, initialDependsOn]);

  const reset = () => {
    setTitle("");
    setStatus("todo");
    setPriority("medium");
    setAssigneeId(null);
    setTeamId(null);
    setDue(null);
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
      await onCreate({
        title: title.trim(),
        status,
        priority,
        assigneeId,
        teamId,
        dueAt: isoFromDateInput(due),
        dependsOnIds: deps,
      });
      rememberPredecessors(deps);
      reset();
      onClose();
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

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-create-due">
            期日
          </label>
          <DateField id="fe4-create-due" value={due} onChange={setDue} testId="fe4-create-due" />
        </div>

        {teams.length > 0 && (
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-create-team">
              チーム
            </label>
            <Select
              id="fe4-create-team"
              value={teamId ?? ""}
              onChange={(v) => setTeamId(v ? (v as common.TeamId) : null)}
              options={[{ value: "", label: "未割当" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              testId="fe4-create-team"
            />
          </div>
        )}

        <div className={styles.formFieldFull}>
          <span className={styles.formLabel}>先行タスク（依存）</span>
          <PredecessorPicker options={dependencyOptions} value={deps} onChange={setDeps} testId="fe4-create-deps" />
        </div>
      </div>
    </Modal>
  );
}
