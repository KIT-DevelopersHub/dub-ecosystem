// Route-entry Components mounted by the FE2 shell via FeatureModule.routes.lazy
// (design §2-3/§2-4). FE2 owns the router; FE4 derives the segment params it needs
// from the pathname and reads the current user / permissions from TaskRouteContext.
//
// Cross-PR seam (FE2 unmerged): at integration FE2 wraps these routes with
//   <QueryClientProvider> + FE4 <ApiClientProvider> (adapting @dub/api-client) +
//   <TaskRouteProvider> (currentUserId + effectivePermissions from FE2 auth).
// Standalone dev keeps using App.tsx (dev-seed) — this module is the shell path.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { common, identity, task } from "@dub/types";
import { useApiClient } from "../api/client-context";
import { listTasks, resolveUsers } from "../api/endpoints";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { TaskWorkspacePage } from "../components/TaskWorkspacePage";
import { TaskListView } from "../components/TaskListView";
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
 * Standalone "マイタスク" route (`/me/tasks`): the current user's tasks across
 * events (assignee-scoped list). Real wiring over FE4 endpoints — no gantt.
 */
export function MeTasksRoute() {
  const client = useApiClient();
  const { currentUserId } = useTaskRoute();
  const [tasks, setTasks] = useState<task.Task[]>([]);
  const [users, setUsers] = useState<UserCache>(() => createUserCache());
  const [loading, setLoading] = useState(false);

  const query = useMemo<task.ListTasksQuery>(
    () => ({ ...(currentUserId ? { assigneeId: currentUserId } : {}) }),
    [currentUserId],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    void listTasks(client, query)
      .then((res) => {
        if (live) setTasks(res.items);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, query]);

  useEffect(() => {
    const ids = tasks.map((t) => t.assigneeId);
    void ensureUsers(users, ids, (batch) => resolveUsers(client, batch)).then((c) => setUsers(new Map(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  const onOpen = (id: common.TaskId) => {
    const t = tasks.find((x) => x.id === id);
    if (t && typeof window !== "undefined") window.location.assign(`/events/${t.eventId}/tasks/${id}`);
  };

  return (
    <section data-testid="fe4-me-tasks">
      <h1 className={styles.actionPanelTitle}>マイタスク</h1>
      <TaskListView tasks={tasks} users={users} hasMore={false} onLoadMore={() => {}} onOpen={onOpen} loading={loading} />
    </section>
  );
}
