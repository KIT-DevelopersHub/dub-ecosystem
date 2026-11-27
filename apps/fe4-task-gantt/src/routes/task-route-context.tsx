// TaskRouteContext — current user / permissions / event supplied by the FE2 shell.
import { createContext, useContext, type ReactNode } from "react";
import type { common, identity } from "@dub/types";

export interface TaskRouteContextValue {
  /** current user id (FE2 /me) — scopes the "マイタスク" route. */
  currentUserId: common.UserId | null;
  /** effectivePermissions from GET /api/v1/me (null = loading -> fail-closed). */
  permissions: readonly identity.PermissionKey[] | null;
  /** Active event id for the event-scoped gantt, supplied REACTIVELY by the shell
   *  from the route param (`/events/:eventId/...`). Preferred over a one-off
   *  window.location parse so the gantt reloads when the shell's global イベント
   *  header switcher navigates the param (a same-route param change does NOT
   *  re-run window.location parsing on its own). Optional/undefined for standalone
   *  or the マイタスク route. */
  eventId?: common.EventId | null;
}

const TaskRouteContext = createContext<TaskRouteContextValue>({
  currentUserId: null,
  permissions: null, // fail-closed default until the shell provides real values
});

export function TaskRouteProvider({ value, children }: { value: TaskRouteContextValue; children: ReactNode }) {
  return <TaskRouteContext.Provider value={value}>{children}</TaskRouteContext.Provider>;
}

export function useTaskRoute(): TaskRouteContextValue {
  return useContext(TaskRouteContext);
}

