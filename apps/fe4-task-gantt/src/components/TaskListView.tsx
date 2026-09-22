import type { task, common } from "@dub/types";
import type { UserCache } from "../domain/user-cache";
import { displayName } from "../domain/user-cache";
import { TaskStatusBadge } from "./TaskStatusBadge";
import styles from "../styles/app.module.css";

export interface TaskListViewProps {
  tasks: task.Task[];
  users: UserCache;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (id: common.TaskId) => void;
  loading?: boolean;
  /** taskId -> WBS number label (e.g. "AA-1-1"); absent ⇒ no badge column. */
  numberById?: ReadonlyMap<common.TaskId, string>;
}

/** Table list + cursor "さらに読み込む" (no auto infinite-scroll — FE1 LoadMore). */
export function TaskListView({ tasks, users, hasMore, onLoadMore, onOpen, loading, numberById }: TaskListViewProps) {
  return (
    <div data-testid="fe4-list-view">
      <table className={styles.table}>
        <thead>
          <tr>
            <th>タイトル</th>
            <th>状態</th>
            <th>担当</th>
            <th>終了日</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className={styles.row} onClick={() => onOpen(t.id)} data-testid={`fe4-task-row-${t.id}`}>
              <td>
                {numberById?.get(t.id) && (
                  <span className={styles.tlRowNum} data-testid={`fe4-list-num-${t.id}`}>{numberById.get(t.id)}</span>
                )}
                {numberById?.get(t.id) ? " " : ""}
                {t.title}
              </td>
              <td><TaskStatusBadge status={t.status} /></td>
              <td>{displayName(users, t.assigneeId)}</td>
              <td>{t.dueAt ? t.dueAt.slice(0, 10) : "―"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <button className={styles.loadMore} onClick={onLoadMore} disabled={loading} data-testid="fe4-load-more">
          さらに読み込む
        </button>
      )}
    </div>
  );
}
