// Route-entry Components mounted by the FE2 shell via FeatureModule.routes.lazy
// (design §2-3/§2-4). FE2 owns the router; FE4 derives the segment params it needs
// from the pathname and reads the current user / permissions from TaskRouteContext.
//
// Cross-PR seam (FE2 unmerged): at integration FE2 wraps these routes with
//   <QueryClientProvider> + FE4 <ApiClientProvider> (adapting @dub/api-client) +
//   <TaskRouteProvider> (currentUserId + effectivePermissions from FE2 auth).
// Standalone dev keeps using App.tsx (dev-seed) — this module is the shell path.
import { useEffect, useState } from "react";
import { useTaskRoute } from "./task-route-context";
import type { common, identity, team } from "@dub/types";
import { ToastProvider } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { listTeams, toDomainTeams } from "../api/endpoints";
import { TaskWorkspacePage } from "../components/TaskWorkspacePage";
import { MyTasksPage } from "../components/MyTasksPage";
import styles from "../styles/app.module.css";

// Context lives in its own module so leaf components (AssigneePicker) can read the
// current user without importing this route module (which imports the pages).
export { TaskRouteProvider, useTaskRoute, type TaskRouteContextValue } from "./task-route-context";

/** Derive the FE3-owned `:eventId` segment from `/events/:eventId/tasks*`. */
export function parseEventIdFromPath(pathname: string): common.EventId | null {
  const m = pathname.match(/\/events\/([^/]+)\/tasks/);
  return m ? m[1]! : null;
}

// The legacy sub-segments that `/events/:eventId/tasks/<seg>` can carry alongside a
// real `:taskId` — matched so a stale `.../board` or `.../gantt` link never gets
// mistaken for a task id and force-opens a non-existent task's detail panel.
const LEGACY_TASK_SUBSEGMENTS = new Set(["board", "gantt"]);

/** Derive a deep-linked `:taskId` from `/events/:eventId/tasks/:taskId` (e.g. the
 *  ⌘K global search's task results), else null. */
export function parseTaskIdFromPath(pathname: string): common.TaskId | null {
  const m = pathname.match(/\/events\/[^/]+\/tasks\/([^/]+)\/?$/);
  if (!m) return null;
  const seg = m[1]!;
  return LEGACY_TASK_SUBSEGMENTS.has(seg) ? null : (seg as common.TaskId);
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
  const initialSelectedTaskId = parseTaskIdFromPath(pathname);
  if (!eventId) return <p className={styles.banner}>イベントが指定されていません。</p>;
  return (
    <TaskWorkspacePage eventId={eventId} permissions={permissions} initialSelectedTaskId={initialSelectedTaskId} />
  );
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

  useEffect(() => {
    let live = true;
    void listTeams(client)
      .then((res) => {
        if (live) setTeams(toDomainTeams(res));
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
      <MyTasksPage currentUserId={currentUserId} people={[]} teams={teams} />
    </ToastProvider>
  );
}
