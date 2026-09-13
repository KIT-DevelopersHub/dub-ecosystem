import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { defaultDropAnimationSideEffects } from "@dnd-kit/core";
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

// `dropAnimation` drives the DragOverlay's Web-Animations-API tween on release
// (position + opacity + our scale-back-to-1) — a real animation, so it is
// disabled outright under prefers-reduced-motion (the settle keyframe below
// and the .cardOverlay lift are separately gated in CSS for the same reason).
// Read once at module load: no live-toggle support needed for an OS setting
// that essentially never changes mid-session, and this keeps jsdom (no
// `matchMedia`) safe for the existing render test.
const prefersReducedMotion =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

const dropAnimation: DropAnimation | null = prefersReducedMotion
  ? null
  : {
      duration: 200,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      sideEffects: defaultDropAnimationSideEffects({
        styles: { active: { opacity: "0.4" } },
      }),
      keyframes: ({ transform }) => [
        { transform: `translate3d(${transform.initial.x}px, ${transform.initial.y}px, 0) scale(1.03)` },
        { transform: `translate3d(${transform.final.x}px, ${transform.final.y}px, 0) scale(1)` },
      ],
    };

function CardBody({ t }: { t: task.Task }) {
  return (
    <>
      <div>{t.title}</div>
      <TaskStatusBadge status={t.status} />
    </>
  );
}

function Card({ t, disabled, justDropped }: { t: task.Task; disabled: boolean; justDropped: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id, disabled });
  return (
    <div
      ref={setNodeRef}
      className={[styles.card, isDragging ? styles.cardDragging : "", justDropped ? styles.cardSettling : ""]
        .filter(Boolean)
        .join(" ")}
      data-testid={`fe4-card-${t.id}`}
      {...attributes}
      {...(disabled ? {} : listeners)}
    >
      <CardBody t={t} />
    </div>
  );
}

function Column({
  status,
  tasks,
  canDrop,
  disabled,
  isValidTarget,
  justDroppedId,
}: {
  status: task.TaskStatus;
  tasks: task.Task[];
  canDrop: boolean;
  disabled: boolean;
  isValidTarget: boolean;
  justDroppedId: common.TaskId | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: disabled || !canDrop });
  const highlight = isOver && canDrop ? (isValidTarget ? styles.columnValid : styles.columnBlocked) : "";
  return (
    <div
      ref={setNodeRef}
      className={`${styles.column} ${highlight}`}
      data-testid={`fe4-column-${status}`}
      aria-disabled={!canDrop}
    >
      <div className={styles.columnHead}>{COLUMN_LABEL[status]} ({tasks.length})</div>
      {tasks.map((t) => (
        <Card key={t.id} t={t} disabled={disabled} justDropped={t.id === justDroppedId} />
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
  const [activeId, setActiveId] = useState<common.TaskId | null>(null);
  const [justDroppedId, setJustDroppedId] = useState<common.TaskId | null>(null);
  const activeTask = activeId ? getTask(activeId) : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragCancel = () => setActiveId(null);

  // active card's status decides which columns are drop-eligible (TASK_STATUS_TRANSITIONS)
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const id = String(e.active.id);
    const to = e.over ? (String(e.over.id) as task.TaskStatus) : null;
    if (!to) return;
    const t = getTask(id);
    if (!t || !canTransition(t.status, to) || t.status === to) return;
    onMove(id, to);
    setJustDroppedId(id);
    // clear regardless of whether the settle keyframe actually ran (it is a
    // no-op under reduced motion, which never fires `animationend`)
    window.setTimeout(() => setJustDroppedId((cur) => (cur === id ? null : cur)), 220);
  };

  return (
    <DndContext onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <div className={styles.board} data-testid="fe4-board-view">
        {BOARD_COLUMNS.map((s) => (
          <Column
            key={s}
            status={s}
            tasks={tasksByStatus(s)}
            canDrop={canWrite}
            disabled={!canWrite}
            isValidTarget={!!activeTask && canTransition(activeTask.status, s)}
            justDroppedId={justDroppedId}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask ? (
          <div className={styles.cardOverlay} data-testid="fe4-card-overlay">
            <CardBody t={activeTask} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
