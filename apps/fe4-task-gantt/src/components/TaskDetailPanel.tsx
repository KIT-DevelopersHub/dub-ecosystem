import { useState } from "react";
import type { common, identity, task } from "@dub/types";
import { Button, IconButton, TextField, Select, DatePicker } from "@dub/ui";
import { allowedTransitions } from "../domain/status-transitions";
import { PRIORITY_LABEL, STATUS_LABEL, dateInputFromIso, isoFromDateInput } from "../domain/task-form";
import { TaskStatusBadge } from "./TaskStatusBadge";
import styles from "../styles/app.module.css";

const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export interface TaskDetailPanelProps {
  task: task.Task;
  users: readonly identity.UserSummary[];
  onSave: (patch: task.UpdateTaskRequest) => void;
  onDelete: () => void;
  onClose: () => void;
  fieldErrors?: Record<string, string>;
  canWrite: boolean;
  canDelete: boolean;
}

/** Side panel: edit form (title/status/priority/assignee/due) + delete confirm. */
export function TaskDetailPanel({
  task: t,
  users,
  onSave,
  onDelete,
  onClose,
  fieldErrors,
  canWrite,
  canDelete,
}: TaskDetailPanelProps) {
  const [title, setTitle] = useState(t.title);
  const [status, setStatus] = useState<task.TaskStatus>(t.status);
  const [priority, setPriority] = useState<task.TaskPriority>(t.priority);
  const [assigneeId, setAssigneeId] = useState<common.UserId | null>(t.assigneeId);
  const [due, setDue] = useState<string | null>(dateInputFromIso(t.dueAt));
  const [confirming, setConfirming] = useState(false);

  // status may move only to an allowed target (or stay) — same source as board D&D
  const statusOptions = [t.status, ...allowedTransitions(t.status)].filter((s, i, arr) => arr.indexOf(s) === i);
  const nextDueIso = isoFromDateInput(due);
  const dirty =
    title !== t.title ||
    status !== t.status ||
    priority !== t.priority ||
    assigneeId !== t.assigneeId ||
    nextDueIso !== t.dueAt;

  const save = () => {
    const patch: task.UpdateTaskRequest = { version: t.version };
    if (title !== t.title) patch.title = title;
    if (status !== t.status) patch.status = status;
    if (priority !== t.priority) patch.priority = priority;
    if (assigneeId !== t.assigneeId) patch.assigneeId = assigneeId;
    if (nextDueIso !== t.dueAt) patch.dueAt = nextDueIso;
    onSave(patch);
  };

  return (
    <>
      <div className={styles.panelScrim} onClick={onClose} data-testid="fe4-detail-scrim" aria-hidden />
      <aside className={styles.panel} data-testid="fe4-detail-panel" aria-label="タスク詳細">
        <header className={styles.panelHeader}>
          <div className={styles.panelHeadInfo}>
            <TaskStatusBadge status={t.status} />
            <h2 className={styles.panelTitle}>タスクの詳細</h2>
          </div>
          <IconButton name="x" aria-label="閉じる" variant="ghost" onClick={onClose} testId="fe4-detail-close" />
        </header>

        <div className={styles.formField}>
          <label className={styles.formLabel} htmlFor="fe4-detail-title">
            タイトル
          </label>
          <TextField id="fe4-detail-title" value={title} disabled={!canWrite} onChange={setTitle} testId="fe4-detail-title" />
          {fieldErrors?.title && (
            <span className={styles.fieldError} data-testid="fe4-error-title">
              {fieldErrors.title}
            </span>
          )}
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-status">
              ステータス
            </label>
            <Select
              id="fe4-detail-status"
              value={status}
              disabled={!canWrite}
              onChange={(v) => setStatus(v as task.TaskStatus)}
              options={statusOptions.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              testId="fe4-detail-status"
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-priority">
              優先度
            </label>
            <Select
              id="fe4-detail-priority"
              value={priority}
              disabled={!canWrite}
              onChange={(v) => setPriority(v as task.TaskPriority)}
              options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              testId="fe4-detail-priority"
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-assignee">
              担当
            </label>
            <Select
              id="fe4-detail-assignee"
              value={assigneeId ?? ""}
              disabled={!canWrite}
              onChange={(v) => setAssigneeId(v ? (v as common.UserId) : null)}
              options={[{ value: "", label: "未割当" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
              testId="fe4-detail-assignee"
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fe4-detail-due">
              期日
            </label>
            <DatePicker id="fe4-detail-due" value={due} disabled={!canWrite} onChange={setDue} testId="fe4-detail-due" />
          </div>
        </div>

        <div className={styles.panelActions}>
          <Button onClick={save} disabled={!canWrite || !dirty} testId="fe4-detail-save">
            保存
          </Button>
          {canDelete && !confirming && (
            <Button variant="danger" onClick={() => setConfirming(true)} testId="fe4-detail-delete">
              削除
            </Button>
          )}
        </div>

        {confirming && (
          <div className={styles.confirmBox} data-testid="fe4-confirm-delete">
            <p className={styles.confirmText}>このタスクを削除しますか？この操作は取り消せません。</p>
            <div className={styles.panelActions}>
              <Button variant="danger" onClick={onDelete} testId="fe4-confirm-yes">
                削除する
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} testId="fe4-confirm-no">
                やめる
              </Button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
