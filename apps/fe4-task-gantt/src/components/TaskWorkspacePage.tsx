import { useEffect, useMemo, useState } from "react";
import type { task, common, identity } from "@dub/types";
import { useApiClient } from "../api/client-context";
import { resolveUsers } from "../api/endpoints";
import { useGanttData } from "../api/useGanttData";
import { useTaskStore } from "../store/useTaskStore";
import { emptyFilter, toListTasksQuery, type TaskFilterState } from "../domain/task-query";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { taskCapabilities } from "../domain/permissions";
import { fieldErrorMap } from "../domain/error-mapping";
import { ViewSwitcher, type TaskView } from "./ViewSwitcher";
import { TaskFilterBar } from "./TaskFilterBar";
import { TaskListView } from "./TaskListView";
import { TaskBoardView } from "./TaskBoardView";
import { GanttView } from "./GanttView";
import { TaskDetailPanel } from "./TaskDetailPanel";
import styles from "../styles/app.module.css";

export interface TaskWorkspacePageProps {
  eventId: common.EventId;
  /** effectivePermissions from GET /api/v1/me (null = still loading -> deny). */
  permissions: readonly identity.PermissionKey[] | null;
  initialView?: TaskView;
}

export function TaskWorkspacePage({ eventId, permissions, initialView = "list" }: TaskWorkspacePageProps) {
  const client = useApiClient();
  const store = useTaskStore();
  const [view, setView] = useState<TaskView>(initialView);
  const [filter, setFilter] = useState<TaskFilterState>(() => emptyFilter(eventId));
  const [selected, setSelected] = useState<common.TaskId | null>(null);
  const [users, setUsers] = useState<UserCache>(() => createUserCache());
  const caps = useMemo(() => taskCapabilities(permissions), [permissions]);
  const gantt = useGanttData(eventId);

  const query = useMemo(() => toListTasksQuery(filter), [filter]);

  useEffect(() => {
    void store.load(client, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const tasks = store.list();

  // batch-resolve assignee display names (N+1 avoided — one request per new set)
  useEffect(() => {
    const ids = tasks.map((t) => t.assigneeId);
    void ensureUsers(users, ids, (batch) => resolveUsers(client, batch)).then((c) =>
      setUsers(new Map(c)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  const onMove = (id: common.TaskId, to: task.TaskStatus) => {
    const t = store.list().find((x) => x.id === id);
    if (!t) return;
    void store.patchOptimistic(client, id, { status: to }, t.version, { version: t.version, status: to });
  };

  const selectedTask = selected ? store.list().find((t) => t.id === selected) ?? null : null;
  const fieldErrors =
    store.lastError?.action === "field_errors" ? fieldErrorMap((store.lastError as unknown as { details?: unknown }).details) : undefined;

  return (
    <div className={styles.workspace} data-testid="fe4-workspace">
      <div className={styles.toolbar}>
        <ViewSwitcher value={view} onChange={setView} />
        <TaskFilterBar value={filter} onChange={setFilter} disabled={!caps.canRead} />
      </div>

      {store.lastError && (
        <div className={styles.banner} data-testid="fe4-error-banner">{store.lastError.message}</div>
      )}

      {view === "list" && (
        <TaskListView
          tasks={tasks}
          users={users}
          hasMore={store.nextCursor !== null}
          onLoadMore={() => void store.loadMore(client, query)}
          onOpen={setSelected}
        />
      )}
      {view === "board" && (
        <TaskBoardView
          tasksByStatus={(s) => store.column(s)}
          getTask={(id) => store.list().find((t) => t.id === id)}
          onMove={onMove}
          canWrite={caps.canWrite}
        />
      )}
      {view === "gantt" && gantt.data && (
        <GanttView dto={gantt.data} zoom="week" truncated={gantt.data.rows.length >= 2000} />
      )}

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          canWrite={caps.canWrite}
          canDelete={caps.canDelete}
          {...(fieldErrors ? { fieldErrors } : {})}
          onSave={(patch) => void store.patchOptimistic(client, selectedTask.id, patch, selectedTask.version, patch)}
          onDelete={() => {
            void store.removeTask(client, selectedTask.id).then(() => setSelected(null));
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
