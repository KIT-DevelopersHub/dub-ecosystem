// Route-entry Components mounted by the FE2 shell via FeatureModule.routes.lazy
// (design §2-3/§2-4). FE2 owns the router; FE4 derives the segment params it needs
// from the pathname and reads the current user / permissions from TaskRouteContext.
//
// Cross-PR seam (FE2 unmerged): at integration FE2 wraps these routes with
//   <QueryClientProvider> + FE4 <ApiClientProvider> (adapting @dub/api-client) +
//   <TaskRouteProvider> (currentUserId + effectivePermissions from FE2 auth).
// Standalone dev keeps using App.tsx (dev-seed) — this module is the shell path.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { common, identity, team } from "@dub/types";
import { ToastProvider } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTeams, listEvents, toDomainTeams } from "../api/endpoints";
import { TaskWorkspacePage } from "../components/TaskWorkspacePage";
import { MyTasksPage } from "../components/MyTasksPage";
import type { EventOption } from "../components/MyTaskCreateModal";
import styles from "../styles/app.module.css";

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

/** Derive the FE3-owned `:eventId` segment from `/events/:eventId/tasks*`. */
export function parseEventIdFromPath(pathname: string): common.EventId | null {
  const m = pathname.match(/\/events\/([^/]+)\/tasks/);
  return m ? m[1]! : null;
}

/**
 * Event-scoped workspace route: serves `/events/:eventId/tasks` (and the legacy
 * `.../board`, `.../gantt`, `.../:taskId` sub-segments, all now the single gantt
 * workspace). eventId comes from the path (FE2 router owns the param);
 * permissions come from TaskRouteContext.
 */
export function TaskWorkspaceRoute() {
  const { permissions, eventId: ctxEventId } = useTaskRoute();
  // Prefer the shell-supplied reactive event id (updates the same render when the
  // global header switcher navigates to another event); fall back to a
  // window.location parse for standalone mounts / shells that don't feed it.
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  const eventId = ctxEventId ?? parseEventIdFromPath(pathname);
  if (!eventId) return <p className={styles.banner}>イベントが指定されていません。</p>;
  return <TaskWorkspacePage eventId={eventId} permissions={permissions} />;
}

/**
 * Standalone "マイタスク" route (`/me/tasks`): the current user's task hub across
 * events — 担当(assigned) / 依頼(issued) lenses, from→to list, filters + create.
 * Teams come from the (future member-service) team list; the event options come
 * from event-service so 「タスクを発行」 can pick a 対象イベント (task-service
 * requires a real eventId). Both degrade gracefully — the hub falls back to the
 * events/people derived from the fetched tasks when a fetch yields nothing.
 */
export function MeTasksRoute() {
  const client = useApiClient();
  const { currentUserId } = useTaskRoute();
  const [teams, setTeams] = useState<readonly team.Team[]>([]);
  const [events, setEvents] = useState<readonly EventOption[]>([]);

  useEffect(() => {
    let live = true;
    void listTeams(client)
      .then((res) => {
        if (live) setTeams(toDomainTeams(res));
      })
      .catch(() => {
        /* teams are optional; the hub degrades gracefully without them */
      });
    // Supply the real event list so 「タスクを発行」 is enabled and can target a
    // live event. Without this the button stayed disabled for admins who had no
    // existing tasks to derive an event from (issue: 発行ボタンが押せない).
    void listEvents(client)
      .then((res) => {
        if (live) setEvents(res.items.map((e) => ({ id: e.id, name: e.title })));
      })
      .catch(() => {
        /* events are optional; the hub falls back to task-derived events */
      });
    return () => {
      live = false;
    };
  }, [client]);

  if (!currentUserId) return <p className={styles.banner}>ユーザー情報を読み込んでいます…</p>;

  return (
    <ToastProvider>
      <MyTasksPage currentUserId={currentUserId} people={[]} teams={teams} events={events} />
    </ToastProvider>
  );
}
