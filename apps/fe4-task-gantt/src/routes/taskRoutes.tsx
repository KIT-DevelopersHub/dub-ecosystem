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
import { listTeams } from "../api/endpoints";
import { TaskWorkspacePage } from "../components/TaskWorkspacePage";
import { MyTasksPage } from "../components/MyTasksPage";
import styles from "../styles/app.module.css";

export interface TaskRouteContextValue {
  /** current user id (FE2 /me) — scopes the "マイタスク" route. */
  currentUserId: common.UserId | null;
  /** effectivePermissions from GET /api/v1/me (null = loading -> fail-closed). */
  permissions: readonly identity.PermissionKey[] | null;
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
  const { permissions } = useTaskRoute();
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  const eventId = parseEventIdFromPath(pathname);
  if (!eventId) return <p className={styles.banner}>イベントが指定されていません。</p>;
  return <TaskWorkspacePage eventId={eventId} permissions={permissions} />;
}

/**
 * Standalone "マイタスク" route (`/me/tasks`): the current user's task hub across
 * events — 担当(assigned) / 依頼(issued) lenses, from→to list, filters + create.
 * Teams come from the (future member-service) team list; the roster/event options
 * are derived from the fetched tasks when the shell has none to hand.
 */
export function MeTasksRoute() {
  const client = useApiClient();
  const { currentUserId } = useTaskRoute();
  const [teams, setTeams] = useState<readonly team.Team[]>([]);

  useEffect(() => {
    let live = true;
    void listTeams(client)
      .then((res) => {
        if (live) setTeams(res.items);
      })
      .catch(() => {
        /* teams are optional; the hub degrades gracefully without them */
      });
    return () => {
      live = false;
    };
  }, [client]);

  if (!currentUserId) return <p className={styles.banner}>ユーザー情報を読み込んでいます…</p>;

  return (
    <ToastProvider>
      <MyTasksPage currentUserId={currentUserId} people={[]} teams={teams} events={[]} />
    </ToastProvider>
  );
}
