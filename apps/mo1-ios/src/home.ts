// home — HomeView (S2) view-state reducer over mobile.MobileHomeResponse
// (design §2-1). The frozen response carries { upcomingEvents, myTasks,
// unreadCount }; we surface an "empty" flag and a bounded task preview so the
// Swift HomeViewModel and its tests agree on the exact shape.
import type { event, mobile, task } from "@dub/types";

export interface HomeViewState {
  upcomingEvents: event.EventSummary[];
  /** open tasks first (todo/in_progress/blocked), capped for the home preview. */
  todayTasks: task.TaskSummary[];
  unreadCount: number;
  hasUnread: boolean;
  isEmpty: boolean;
}

const OPEN_STATUSES: ReadonlySet<task.TaskStatus> = new Set(["todo", "in_progress", "blocked"]);

export function buildHomeViewState(res: mobile.MobileHomeResponse, taskPreviewLimit = 5): HomeViewState {
  const open = res.myTasks.filter((t) => OPEN_STATUSES.has(t.status));
  const todayTasks = open.slice(0, Math.max(0, taskPreviewLimit));
  return {
    upcomingEvents: res.upcomingEvents,
    todayTasks,
    unreadCount: res.unreadCount,
    hasUnread: res.unreadCount > 0,
    isEmpty: res.upcomingEvents.length === 0 && open.length === 0,
  };
}
