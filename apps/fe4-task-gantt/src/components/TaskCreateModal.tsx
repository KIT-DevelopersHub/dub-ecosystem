import { useEffect, useState } from "react";
import type { common, identity, task } from "@dub/types";
import { Modal, Button, TextField, Select, DatePicker } from "@dub/ui";
import { PRIORITY_LABEL, STATUS_LABEL, isoFromDateInput } from "../domain/task-form";
import styles from "../styles/app.module.css";

export interface TaskDraft {
  title: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  dueAt: common.ISODateTime | null;
  dependsOnIds: common.TaskId[];
}

export interface TaskCreateModalProps {
  open: boolean;
  onClose: () => void;
  users: readonly identity.UserSummary[];
  /** existing tasks in the event, offered as predecessors (dependencies). */
  dependencyOptions: readonly { id: common.TaskId; title: string }[];
  onCreate: (draft: TaskDraft) => Promise<void>;
  /** date-input value (YYYY-MM-DD) preset when opened from a timeline cell. */
  initialDue?: string | null;
}

// A newly-created task starts in "todo"; only todo-reachable states are offered.
const CREATE_STATUSES: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];
const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export function TaskCreateModal({ open, onClose, users, dependencyOptions, onCreate, initialDue }: TaskCreateModalProps) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<task.TaskStatus>("todo");
  const [priority, setPriority] = useState<task.TaskPriority>("medium");
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [deps, setDeps] = useState<common.TaskId[]>([]);
  const [saving, setSaving] = useState(false);

  // seed the due date from the timeline cell that was clicked (when reopened).
  useEffect(() => {
    if (open) setDue(initialDue ?? null);
  }, [open, initialDue]);

  const reset = () => {
    setTitle("");
    setStatus("todo");
    setPriority("medium");
    setAssigneeId(null);
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
        dueAt: isoFromDateInput(due),
        dependsOnIds: deps,
      });
      reset();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const toggleDep = (id: common.TaskId) =>
    setDeps((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

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
          <DatePicker id="fe4-create-due" value={due} onChange={setDue} testId="fe4-create-due" />
        </div>

        {dependencyOptions.length > 0 && (
          <div className={styles.formFieldFull}>
            <span className={styles.formLabel}>先行タスク（依存）</span>
            <div className={styles.depPicker} data-testid="fe4-create-deps">
              {dependencyOptions.map((t) => (
                <label key={t.id} className={`${styles.depOption} ${deps.includes(t.id) ? styles.depOptionOn : ""}`}>
                  <input
                    type="checkbox"
                    checked={deps.includes(t.id)}
                    onChange={() => toggleDep(t.id)}
                    data-testid={`fe4-create-dep-${t.id}`}
                  />
                  {t.title}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
