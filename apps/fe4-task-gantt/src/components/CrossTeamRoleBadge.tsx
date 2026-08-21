import { task } from "@dub/types";
import { Badge } from "@dub/ui";

/** Tone per cross-team role: お願いした = info (blue), 受け負った = success (green). */
const ROLE_TONE: Record<task.TaskCrossRole, "info" | "success"> = {
  requested: "info",
  accepted: "success",
};

export interface CrossTeamRoleBadgeProps {
  role: task.TaskCrossRole;
  testId?: string;
}

/**
 * The 送る・受け取る status badge shown on a row that is an endpoint of a cross-team
 * link (ADR-0007). The wording is DERIVED from the role — never stored — via
 * `task.TASK_CROSS_ROLE_STATUS_LABEL`, so マイタスク and ガント always show the exact
 * same「タスクをお願いした / 受け負った」text. This is a badge, NOT an arrow.
 */
export function CrossTeamRoleBadge({ role, testId }: CrossTeamRoleBadgeProps) {
  return (
    <Badge tone={ROLE_TONE[role]} testId={testId}>
      {task.TASK_CROSS_ROLE_STATUS_LABEL[role]}
    </Badge>
  );
}
