import { Badge } from "@dub/ui";

export interface TaskTeamBadgeProps {
  /** the task's team name (teamId resolved); nothing is shown when absent. */
  name: string | null | undefined;
  testId?: string;
}

/** The task's team, shown next to the status badge in the detail views. The チーム field is
 *  not an input any more (it follows the 担当), so this keeps it visible. */
export function TaskTeamBadge({ name, testId }: TaskTeamBadgeProps) {
  if (!name) return null;
  return (
    <span title="チーム">
      <Badge tone="neutral" testId={testId}>
        {name}
      </Badge>
    </span>
  );
}
