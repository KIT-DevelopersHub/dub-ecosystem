import type { ReactNode } from "react";

export interface TaskLinkProps {
  taskId: string;
  eventId: string;
  children?: ReactNode;
}

/** Public: deep-link into the detail panel route (design §2-4). */
export function TaskLink({ taskId, eventId, children }: TaskLinkProps) {
  return (
    <a href={`/events/${eventId}/tasks/${taskId}`} data-testid={`fe4-task-link-${taskId}`}>
      {children ?? "タスクを開く"}
    </a>
  );
}
