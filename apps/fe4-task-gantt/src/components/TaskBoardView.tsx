import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import type { task, common } from "@dub/types";
import { BOARD_COLUMNS, canTransition } from "../domain/status-transitions";
import { TaskStatusBadge } from "./TaskStatusBadge";
import styles from "../styles/app.module.css";

const COLUMN_LABEL: Record<task.TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  blocked: "ブロック",
  done: "完了",
  cancelled: "中止",
};

function Card({ t, disabled }: { t: task.Task; disabled: boolean }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: t.id, disabled });
  return (
    <div
      ref={setNodeRef}
      className={styles.card}
      data-testid={`fe4-card-${t.id}`}
      {...attributes}
      {...(disabled ? {} : listeners)}
    >
      <div>{t.title}</div>
      <TaskStatusBadge status={t.status} />
    </div>
  );
}

function Column({
  status,
  tasks,
  canDrop,
  disabled,
}: {
  status: task.TaskStatus;
  tasks: task.Task[];
  canDrop: boolean;
  disabled: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: disabled || !canDrop });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.column} ${isOver && canDrop ? styles.columnBlocked : ""}`}
      data-testid={`fe4-column-${status}`}
      aria-disabled={!canDrop}
    >
      <div className={styles.columnHead}>{COLUMN_LABEL[status]} ({tasks.length})</div>
      {tasks.map((t) => (
        <Card key={t.id} t={t} disabled={disabled} />
      ))}
    </div>
  );
}

export interface TaskBoardViewProps {
  tasksByStatus: (s: task.TaskStatus) => task.Task[];
  getTask: (id: common.TaskId) => task.Task | undefined;
  onMove: (id: common.TaskId, to: task.TaskStatus) => void;
  canWrite: boolean;
}

export function TaskBoardView({ tasksByStatus, getTask, onMove, canWrite }: TaskBoardViewProps) {
  // active card's status decides which columns are drop-eligible (TASK_STATUS_TRANSITIONS)
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const to = e.over ? (String(e.over.id) as task.TaskStatus) : null;
    if (!to) return;
    const t = getTask(id);
    if (!t || !canTransition(t.status, to) || t.status === to) return;
    onMove(id, to);
  };
  return (
    <DndContext onDragEnd={onDragEnd}>
      <div className={styles.board} data-testid="fe4-board-view">
        {BOARD_COLUMNS.map((s) => (
          <Column key={s} status={s} tasks={tasksByStatus(s)} canDrop={canWrite} disabled={!canWrite} />
        ))}
      </div>
    </DndContext>
  );
}
