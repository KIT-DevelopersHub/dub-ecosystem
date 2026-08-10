import type { task } from "@dub/types";
import { Badge, type BadgeTone } from "@dub/ui";

const LABEL: Record<task.TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  blocked: "ブロック",
  done: "完了",
  cancelled: "中止",
};

/** Task status → @dub/ui semantic tone (mirrors the old app.module.css colors). */
const TONE: Record<task.TaskStatus, BadgeTone> = {
  todo: "neutral",
  in_progress: "info",
  blocked: "warning",
  done: "success",
  cancelled: "neutral",
};

export interface TaskStatusBadgeProps {
  status: task.TaskStatus;
  testId?: string;
}

/** Public (FE3 reuses in action screens). Built on the @dub/ui design-system Badge. */
export function TaskStatusBadge({ status, testId }: TaskStatusBadgeProps) {
  return (
    <Badge tone={TONE[status]} testId={testId ?? `fe4-status-${status}`}>
      {LABEL[status]}
    </Badge>
  );
}
