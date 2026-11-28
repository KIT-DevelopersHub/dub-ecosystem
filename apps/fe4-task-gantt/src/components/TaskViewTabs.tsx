import { Tabs } from "@dub/ui";
import type { common } from "@dub/types";
import { useTaskRoute } from "../routes/task-route-context";
import { isViewDisabled, loadLastSelectedEvent, taskHubPath, type TaskHubView } from "../domain/task-hub-view";
import styles from "../styles/app.module.css";

const VIEW_LABEL: Record<TaskHubView, string> = { gantt: "ガント", kanban: "カンバン" };
const VIEWS: readonly TaskHubView[] = ["gantt", "kanban"];

export interface TaskViewTabsProps {
  /** The view this route shows. */
  value: TaskHubView;
  /** Event on screen (gantt route); kanban falls back to the last selected event. */
  eventId?: common.EventId | null;
}

/**
 * #880: the ガント / カンバン switch at the top of the task app. Both launcher entries
 * (マイタスク / ガントチャート) land here; a tab moves to the other view's route.
 * A view whose app is 無効 for this role stays visible but disabled.
 */
export function TaskViewTabs({ value, eventId = null }: TaskViewTabsProps) {
  const { navigate, views } = useTaskRoute();
  const go = (id: string) => {
    const view = id as TaskHubView;
    if (view === value) return;
    const to = taskHubPath(view, eventId ?? loadLastSelectedEvent());
    if (navigate) navigate(to);
    else if (typeof window !== "undefined") window.location.assign(to);
  };
  return (
    <nav className={styles.hubTabs} aria-label="タスクの表示">
      <Tabs
        testId="fe4-task-view-tabs"
        activeId={value}
        onChange={go}
        items={VIEWS.map((v) => ({ id: v, label: VIEW_LABEL[v], disabled: isViewDisabled(v, views) }))}
      />
    </nav>
  );
}
