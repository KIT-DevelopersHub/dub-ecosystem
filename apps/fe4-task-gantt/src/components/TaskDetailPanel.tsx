import { useState } from "react";
import type { task } from "@dub/types";
import { BOARD_COLUMNS, allowedTransitions } from "../domain/status-transitions";
import { TaskStatusBadge } from "./TaskStatusBadge";
import styles from "../styles/app.module.css";

const PRIORITIES: task.TaskPriority[] = ["low", "medium", "high", "urgent"];

export interface TaskDetailPanelProps {
  task: task.Task;
  onSave: (patch: task.UpdateTaskRequest) => void;
  onDelete: () => void;
  onClose: () => void;
  fieldErrors?: Record<string, string>;
  canWrite: boolean;
  canDelete: boolean;
}

/** Side panel: edit form + delete (delete = ConfirmDialog, non-optimistic). */
export function TaskDetailPanel({ task: t, onSave, onDelete, onClose, fieldErrors, canWrite, canDelete }: TaskDetailPanelProps) {
  const [title, setTitle] = useState(t.title);
  const [status, setStatus] = useState<task.TaskStatus>(t.status);
  const [priority, setPriority] = useState<task.TaskPriority>(t.priority);
  const [confirming, setConfirming] = useState(false);

  // status can only move to an allowed target (or stay) — same source as board D&D
  const statusOptions = [t.status, ...allowedTransitions(t.status)].filter(
    (s, i, arr) => arr.indexOf(s) === i,
  );

  const save = () => {
    const patch: task.UpdateTaskRequest = { version: t.version };
    if (title !== t.title) patch.title = title;
    if (status !== t.status) patch.status = status;
    if (priority !== t.priority) patch.priority = priority;
    onSave(patch);
  };

  return (
    <aside className={styles.panel} data-testid="fe4-detail-panel" aria-label="タスク詳細">
      <button onClick={onClose} data-testid="fe4-detail-close" aria-label="閉じる">×</button>
      <div className={styles.field}>
        <label>タイトル</label>
        <input value={title} disabled={!canWrite} onChange={(e) => setTitle(e.target.value)} data-testid="fe4-detail-title" />
        {fieldErrors?.title && <span className={styles.fieldError} data-testid="fe4-error-title">{fieldErrors.title}</span>}
      </div>
      <div className={styles.field}>
        <label>状態 <TaskStatusBadge status={t.status} /></label>
        <select value={status} disabled={!canWrite} onChange={(e) => setStatus(e.target.value as task.TaskStatus)} data-testid="fe4-detail-status">
          {BOARD_COLUMNS.filter((s) => statusOptions.includes(s)).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label>優先度</label>
        <select value={priority} disabled={!canWrite} onChange={(e) => setPriority(e.target.value as task.TaskPriority)} data-testid="fe4-detail-priority">
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <button className={styles.btn} disabled={!canWrite} onClick={save} data-testid="fe4-detail-save">保存</button>
      {canDelete && !confirming && (
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => setConfirming(true)} data-testid="fe4-detail-delete">削除</button>
      )}
      {confirming && (
        <div data-testid="fe4-confirm-delete">
          <p>このタスクを削除しますか？</p>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={onDelete} data-testid="fe4-confirm-yes">削除する</button>
          <button className={styles.btn} onClick={() => setConfirming(false)} data-testid="fe4-confirm-no">やめる</button>
        </div>
      )}
    </aside>
  );
}
