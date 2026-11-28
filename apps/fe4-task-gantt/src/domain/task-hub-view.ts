// #880: マイタスク and ガント are one app with two views (ガント / カンバン). Each launcher entry
// keeps its own URL and default view (/me/tasks = カンバン, /events/:id/tasks = ガント); the tabs
// at the top move between them. Pure helpers so the switch is unit-testable without a router.
import type { common, task } from "@dub/types";
import { BOARD_COLUMNS, canTransition } from "./status-transitions";

export type TaskHubView = "gantt" | "kanban";

/** Per-view "may open" flags the shell derives from the launcher's app levels. */
export type TaskViewAvailability = Readonly<Record<TaskHubView, boolean>>;

/** Same key the shell's イベント switcher writes (fe2 features/gantt/selectedEventStore). */
export const SELECTED_EVENT_STORAGE_KEY = "dub:selected-event";

export function loadLastSelectedEvent(): common.EventId | null {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_EVENT_STORAGE_KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Where a tab leads. ガント needs an event: the one on screen, else the last one the user
 * worked in, else the shell's /gantt landing (event picker).
 */
export function taskHubPath(view: TaskHubView, eventId: common.EventId | null): string {
  if (view === "kanban") return "/me/tasks";
  return eventId ? `/events/${eventId}/tasks/gantt` : "/gantt";
}

/**
 * A tab is disabled (never hidden) when its app is 無効 for this role. No flags from the
 * host (standalone / still loading) ⇒ enabled; the shell's route guard is the authority.
 */
export function isViewDisabled(view: TaskHubView, availability: TaskViewAvailability | undefined): boolean {
  return availability ? !availability[view] : false;
}

/** Kanban columns = the existing task statuses, in board order. */
export const KANBAN_COLUMNS: readonly task.TaskStatus[] = BOARD_COLUMNS;

export function groupByStatus(tasks: readonly task.Task[]): Record<task.TaskStatus, task.Task[]> {
  const out = Object.fromEntries(KANBAN_COLUMNS.map((s) => [s, [] as task.Task[]])) as Record<
    task.TaskStatus,
    task.Task[]
  >;
  for (const t of tasks) out[t.status]?.push(t);
  return out;
}

/** Whether a card may move to `to`: editable (#881 rules), a real change, and an allowed transition. */
export function canMoveCard(t: task.Task, to: task.TaskStatus, canEdit: (id: common.TaskId) => boolean): boolean {
  return t.status !== to && canTransition(t.status, to) && canEdit(t.id);
}
