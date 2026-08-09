// Thin panel FE3 renders inside a `task_management` action detail. FE4 owns no
// action payload — the panel is a summary affordance + deep-link into FE4's
// event-scoped tasks board (design §2-4). Self-styled (no @dub/ui swap).
import type { ActionPanelProps } from "../contracts/event-action";
import styles from "../styles/app.module.css";

/** Deep-link target for the event's tasks board (owned by FE4 route segment). */
function eventTasksHref(eventId: string): string {
  return `/events/${eventId}/tasks`;
}

export function TaskActionPanel({ event, action }: ActionPanelProps) {
  return (
    <section className={styles.actionPanel} data-testid={`fe4-action-panel-${action.id}`}>
      <p className={styles.actionPanelTitle}>タスク管理</p>
      <a
        className={styles.actionPanelLink}
        href={eventTasksHref(event.id)}
        data-testid={`fe4-action-panel-link-${action.id}`}
      >
        タスクボードを開く
      </a>
    </section>
  );
}
