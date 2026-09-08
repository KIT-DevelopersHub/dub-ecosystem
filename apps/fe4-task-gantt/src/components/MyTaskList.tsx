import type { task, common } from "@dub/types";
import { Badge, SkeletonTable, EmptyState, LoadMore, type BadgeTone } from "@dub/ui";
import type { UserCache } from "../domain/user-cache";
import { isOverdue } from "../domain/my-tasks";
import { PRIORITY_LABEL } from "../domain/task-form";
import { FromToCell } from "./FromToCell";
import { TaskStatusBadge } from "./TaskStatusBadge";
import styles from "../styles/app.module.css";

const PRIORITY_TONE: Record<task.TaskPriority, BadgeTone> = {
  urgent: "danger",
  high: "warning",
  medium: "neutral",
  low: "neutral",
};

function formatDue(iso: common.ISODateTime | null): string {
  return iso ? iso.slice(0, 10) : "―";
}

export interface MyTaskListProps {
  tasks: task.Task[];
  users: UserCache;
  teamNames: Map<common.TeamId, string>;
  loading?: boolean;
  /** open the task detail dialog (feedback #2 — row click shows 内容, not navigate). */
  onSelect: (task: task.Task) => void;
  /** number of rows currently revealed (windowing for large lists). */
  visibleCount: number;
  onShowMore: () => void;
  now?: number;
}

/**
 * Unified task list for the My Tasks hub — one row per task showing 依頼→担当
 * (from→to), title, team, status, priority, due (design ask (c): a single list,
 * not a chat). Renders only `visibleCount` rows so a 300-person backlog stays
 * light; "さらに表示" reveals more. Skeleton on first load, empty-state otherwise.
 */
export function MyTaskList({
  tasks,
  users,
  teamNames,
  loading,
  onSelect,
  visibleCount,
  onShowMore,
  now = Date.now(),
}: MyTaskListProps) {
  if (loading) {
    return (
      <div data-testid="fe4-mytasks-loading">
        <SkeletonTable rows={6} columns={6} />
      </div>
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

  const shown = tasks.slice(0, visibleCount);

  return (
    <div data-testid="fe4-mytasks-list">
      <table className={styles.myTable}>
        <thead>
          <tr>
            <th className={styles.colFromTo}>依頼 → 担当</th>
            <th>タイトル</th>
            <th>チーム</th>
            <th>状態</th>
            <th>優先度</th>
            <th>終了日</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => {
            const overdue = isOverdue(t, now);
            const team = t.teamId ? teamNames.get(t.teamId) : null;
            return (
              <tr
                key={t.id}
                className={`${styles.myRow} ${overdue ? styles.rowOverdue : ""}`}
                onClick={() => onSelect(t)}
                data-testid={`fe4-mytask-row-${t.id}`}
                tabIndex={0}
                role="button"
                aria-label={`${t.title} の詳細を開く`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(t);
                  }
                }}
              >
                <td className={styles.colFromTo}>
                  <FromToCell fromId={t.createdBy ?? null} toId={t.assigneeId} users={users} testId={`fe4-fromto-${t.id}`} />
                </td>
                <td className={styles.cellTitle}>{t.title}</td>
                <td>{team ? <Badge tone="info">{team}</Badge> : <span className={styles.muted}>―</span>}</td>
                <td>
                  <TaskStatusBadge status={t.status} />
                </td>
                <td>
                  <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Badge>
                </td>
                <td className={overdue ? styles.dueOverdue : undefined}>
                  {formatDue(t.dueAt)}
                  {overdue && <span className={styles.overdueTag}> 期限切れ</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.listFoot}>
        <span className={styles.countHint} data-testid="fe4-mytasks-count">
          {shown.length} / {tasks.length} 件
        </span>
        <LoadMore hasMore={visibleCount < tasks.length} loading={false} onLoadMore={onShowMore} label="さらに表示" testId="fe4-mytasks-more" />
      </div>
    </div>
  );
}
