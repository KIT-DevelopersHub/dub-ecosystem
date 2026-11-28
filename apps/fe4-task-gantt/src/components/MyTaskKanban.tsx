import { useMemo, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { common, task } from "@dub/types";
import { Badge, EmptyState, ErrorState, LoadMore, Menu, Skeleton } from "@dub/ui";
import type { UserCache } from "../domain/user-cache";
import { isOverdue, requesterOf } from "../domain/my-tasks";
import { READ_ONLY_TASK_HINT } from "../domain/permissions";
import { canMoveCard, groupByStatus, KANBAN_COLUMNS } from "../domain/task-hub-view";
import { FromToCell } from "./FromToCell";
import styles from "../styles/app.module.css";

const COLUMN_LABEL: Record<task.TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  blocked: "ブロック",
  done: "完了",
  cancelled: "中止",
};

const COLUMN_PAGE = 25;

export interface MyTaskKanbanProps {
  tasks: task.Task[];
  users: UserCache;
  teamNames: Map<common.TeamId, string>;
  loading?: boolean;
  loadError?: unknown;
  onRetry?: () => void;
  onSelect: (t: task.Task) => void;
  /** Optimistic status change (the page applies it first and rolls back on failure). */
  onMove: (t: task.Task, to: task.TaskStatus) => void;
  /** #881 per-task edit right; a locked card cannot be dragged or moved. */
  canEdit: (id: common.TaskId) => boolean;
  now?: number;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

function KanbanCard({
  t,
  users,
  teamNames,
  editable,
  onSelect,
  onMove,
  now,
}: {
  t: task.Task;
  users: UserCache;
  teamNames: Map<common.TeamId, string>;
  editable: boolean;
  onSelect: (t: task.Task) => void;
  onMove: (t: task.Task, to: task.TaskStatus) => void;
  now: number;
}) {
  const { listeners, setNodeRef, isDragging, transform } = useDraggable({ id: t.id, disabled: !editable });
  const overdue = isOverdue(t, now);
  const targets = editable ? KANBAN_COLUMNS.filter((s) => canMoveCard(t, s, () => true)) : [];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(t);
    }
  };
  return (
    <div
      ref={setNodeRef}
      className={`${styles.kanbanCard} ${editable ? styles.kanbanCardMovable : ""} ${isDragging ? styles.kanbanCardDragging : ""}`}
      data-testid={`fe4-kanban-card-${t.id}`}
      data-editable={editable ? "true" : "false"}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${t.title} の詳細を開く`}
      title={editable ? undefined : READ_ONLY_TASK_HINT}
      onClick={() => onSelect(t)}
      onKeyDown={onKeyDown}
      {...(editable ? listeners : {})}
    >
      <div className={styles.kanbanCardTitle}>{t.title}</div>
      <FromToCell
        fromId={requesterOf(t)}
        toId={t.assigneeId}
        toTeamName={t.assigneeTeamId ? teamNames.get(t.assigneeTeamId) ?? null : null}
        users={users}
        testId={`fe4-kanban-fromto-${t.id}`}
      />
      <div className={styles.kanbanCardMeta}>
        <span className={overdue ? styles.dueOverdue : styles.muted}>
          {t.dueAt ? t.dueAt.slice(0, 10) : "終了日なし"}
          {overdue && <span className={styles.overdueTag}> 期限切れ</span>}
        </span>
        {!editable && (
          <Badge tone="neutral" testId={`fe4-kanban-locked-${t.id}`}>
            閲覧のみ
          </Badge>
        )}
        {targets.length > 0 && (
          <span onClick={stop} onPointerDown={stop} onKeyDown={stop}>
            <Menu
              testId={`fe4-kanban-move-${t.id}`}
              label="移動"
              menuLabel={`${t.title} の状態を変更`}
              variant="ghost"
              items={targets.map((s) => ({
                id: s,
                label: COLUMN_LABEL[s],
                onSelect: () => onMove(t, s),
                testId: `fe4-kanban-move-${t.id}-${s}`,
              }))}
            />
          </span>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({
  status,
  count,
  droppable,
  children,
}: {
  status: task.TaskStatus;
  count: number;
  droppable: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !droppable });
  return (
    <section
      ref={setNodeRef}
      className={`${styles.kanbanColumn} ${isOver && droppable ? styles.kanbanColumnOver : ""}`}
      data-testid={`fe4-kanban-column-${status}`}
      aria-label={`${COLUMN_LABEL[status]} ${count}件`}
    >
      <header className={styles.kanbanColumnHead}>
        <span>{COLUMN_LABEL[status]}</span>
        <span className={styles.kanbanCount}>{count}</span>
      </header>
      <div className={styles.kanbanColumnBody}>{children}</div>
    </section>
  );
}

function KanbanSkeleton() {
  return (
    <div className={styles.kanbanBoard} data-testid="fe4-kanban-loading" role="status" aria-label="読み込み中">
      {KANBAN_COLUMNS.map((s) => (
        <section key={s} className={styles.kanbanColumn}>
          <header className={styles.kanbanColumnHead}>
            <span>{COLUMN_LABEL[s]}</span>
          </header>
          <div className={styles.kanbanColumnBody}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={styles.kanbanCard}>
                <Skeleton width="80%" />
                <Skeleton width="55%" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * #880: マイタスク as a kanban — one column per existing task status. Cards move by drag
 * or the 「移動」 menu (keyboard / touch); both go through `onMove` (optimistic). Cards the
 * viewer may not edit (#881) are visible but locked.
 */
export function MyTaskKanban({
  tasks,
  users,
  teamNames,
  loading,
  loadError = null,
  onRetry,
  onSelect,
  onMove,
  canEdit,
  now = Date.now(),
}: MyTaskKanbanProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<task.Task | null>(null);
  const [visible, setVisible] = useState<Partial<Record<task.TaskStatus, number>>>({});
  const byStatus = useMemo(() => groupByStatus(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  if (loading) return <KanbanSkeleton />;

  if (loadError && tasks.length === 0) {
    const status = (loadError as { status?: unknown }).status;
    return (
      <ErrorState
        error={{
          code: status === 429 ? "RATE_LIMITED" : "LOAD_FAILED",
          message: `タスクを読み込めませんでした。${
            status === 429 ? "アクセスが集中しています。少し待ってから再試行してください。" : "時間をおいて再試行してください。"
          }`,
        }}
        {...(onRetry ? { onRetry } : {})}
        testId="fe4-mytasks-error"
      />
    );
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="タスクがありません"
        description="条件に合うタスクが見つかりませんでした。フィルタを変える、または「タスクを発行」から新しいタスクを追加してください。"
        testId="fe4-mytasks-empty"
      />
    );
  }

  const onDragStart = (e: DragStartEvent) => setDragging(byId.get(String(e.active.id)) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const t = byId.get(String(e.active.id));
    const to = e.over ? (String(e.over.id) as task.TaskStatus) : null;
    if (t && to && canMoveCard(t, to, canEdit)) onMove(t, to);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className={styles.kanbanBoard} data-testid="fe4-mytasks-kanban">
        {KANBAN_COLUMNS.map((s) => {
          const items = byStatus[s];
          const limit = visible[s] ?? COLUMN_PAGE;
          return (
            <KanbanColumn
              key={s}
              status={s}
              count={items.length}
              droppable={dragging ? canMoveCard(dragging, s, canEdit) : false}
            >
              {items.length === 0 ? (
                <p className={styles.kanbanEmpty}>なし</p>
              ) : (
                items.slice(0, limit).map((t) => (
                  <KanbanCard
                    key={t.id}
                    t={t}
                    users={users}
                    teamNames={teamNames}
                    editable={canEdit(t.id)}
                    onSelect={onSelect}
                    onMove={onMove}
                    now={now}
                  />
                ))
              )}
              <LoadMore
                hasMore={limit < items.length}
                loading={false}
                onLoadMore={() => setVisible((v) => ({ ...v, [s]: limit + COLUMN_PAGE }))}
                label="さらに表示"
                testId={`fe4-kanban-more-${s}`}
              />
            </KanbanColumn>
          );
        })}
      </div>
    </DndContext>
  );
}
