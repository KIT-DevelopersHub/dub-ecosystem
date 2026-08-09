import type { task } from "@dub/types";
import styles from "../styles/app.module.css";

const LABEL: Record<task.TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  blocked: "ブロック",
  done: "完了",
  cancelled: "中止",
};

export interface TaskStatusBadgeProps {
  status: task.TaskStatus;
  testId?: string;
}

/** Public (FE3 reuses in action screens). */
export function TaskStatusBadge({ status, testId }: TaskStatusBadgeProps) {
  return (
    <span
      className={`${styles.badge} ${styles[`badge_${status}`]}`}
      data-testid={testId ?? `fe4-status-${status}`}
    >
      {LABEL[status]}
    </span>
  );
}
