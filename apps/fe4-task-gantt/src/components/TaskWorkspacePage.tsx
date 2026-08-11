import { useEffect, useMemo, useState } from "react";
import type { task, common, identity } from "@dub/types";
import type { gantt as ganttNs } from "@dub/types";
import { Button } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { replaceDependencies, resolveUsers } from "../api/endpoints";
import { useGanttData } from "../api/useGanttData";
import { useTaskStore } from "../store/useTaskStore";
import { emptyFilter, toListTasksQuery, type TaskFilterState } from "../domain/task-query";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { taskCapabilities } from "../domain/permissions";
import { fieldErrorMap } from "../domain/error-mapping";
import { TaskFilterBar } from "./TaskFilterBar";
import { GanttView } from "./GanttView";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskCreateModal, type TaskDraft } from "./TaskCreateModal";
import styles from "../styles/app.module.css";

export interface TaskWorkspacePageProps {
  eventId: common.EventId;
  /** effectivePermissions from GET /api/v1/me (null = still loading -> deny). */
  permissions: readonly identity.PermissionKey[] | null;
}

/**
 * Gantt-only task workspace: a single self-drawn timeline with day/week/month
 * zoom, a working status filter, and full CRUD (create modal + detail-panel
 * edit/delete) wired through the optimistic store. The former list/board view
 * switch was removed — the gantt is the one canvas.
 */
export function TaskWorkspacePage({ eventId, permissions }: TaskWorkspacePageProps) {
  const client = useApiClient();
  const store = useTaskStore();
  const [filter, setFilter] = useState<TaskFilterState>(() => emptyFilter(eventId));
  const [selected, setSelected] = useState<common.TaskId | null>(null);
  const [creating, setCreating] = useState(false);
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
    void ensureUsers(users, ids, (batch) => resolveUsers(client, batch)).then((c) => setUsers(new Map(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  const userList = useMemo(() => [...users.values()], [users]);
  const statusById = useMemo(() => new Map(tasks.map((t) => [t.id, t.status] as const)), [tasks]);

  // The status filter narrows the gantt: keep only rows whose task is in the
  // (server-filtered) store set, and dependencies between two visible tasks.
  const filteredDto = useMemo<ganttNs.GanttChartDTO | null>(() => {
    if (!gantt.data) return null;
    const visible = new Set(tasks.map((t) => t.id));
    return {
      ...gantt.data,
      rows: gantt.data.rows.filter((r) => visible.has(r.taskId)),
      dependencies: gantt.data.dependencies.filter((d) => visible.has(d.fromTaskId) && visible.has(d.toTaskId)),
      criticalTaskIds: (gantt.data.criticalTaskIds ?? []).filter((id) => visible.has(id)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gantt.data, tasks]);

  const selectedTask = selected ? tasks.find((t) => t.id === selected) ?? null : null;
  const fieldErrors =
    store.lastError?.action === "field_errors"
      ? fieldErrorMap((store.lastError as unknown as { details?: unknown }).details)
      : undefined;

  const MS_PER_DAY = 86_400_000;
  const onReschedule = (id: common.TaskId, deltaDays: number) => {
    const t = store.list().find((x) => x.id === id);
    const row = gantt.data?.rows.find((r) => r.taskId === id);
    if (!t || !row?.endsAt) return;
    const nextDue = new Date(Date.parse(row.endsAt) + deltaDays * MS_PER_DAY).toISOString();
    void store
      .patchOptimistic(client, id, { dueAt: nextDue }, t.version, { version: t.version, dueAt: nextDue })
      .then((ok) => {
        if (ok) void gantt.refetchFresh();
      });
  };

  const onCreate = async (draft: TaskDraft) => {
    const created = await store.create(client, {
      eventId,
      title: draft.title,
      ...(draft.priority ? { priority: draft.priority } : {}),
      ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
      ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
    });
    if (!created) return;
    let version = created.version;
    if (draft.status !== "todo") {
      const patched = await store.patchOptimistic(
        client,
        created.id,
        { status: draft.status },
        version,
        { version, status: draft.status },
      );
      if (patched) version = patched.version;
    }
    if (draft.dependsOnIds.length > 0) {
      try {
        const withDeps = await replaceDependencies(client, created.id, { version, dependsOnIds: draft.dependsOnIds });
        version = withDeps.version;
      } catch {
        /* dependency cycle etc. — task is still created; surfaced separately */
      }
    }
    await store.load(client, query);
    await gantt.refetchFresh();
  };

  const onSaveDetail = (patch: task.UpdateTaskRequest) => {
    if (!selectedTask) return;
    void store
      .patchOptimistic(client, selectedTask.id, patch, selectedTask.version, patch)
      .then((ok) => {
        if (ok) void gantt.refetchFresh();
      });
  };

  const onDeleteDetail = () => {
    if (!selectedTask) return;
    void store.removeTask(client, selectedTask.id).then(async (ok) => {
      if (ok) {
        setSelected(null);
        await store.load(client, query);
        await gantt.refetchFresh();
      }
    });
  };

  return (
    <div className={styles.workspace} data-testid="fe4-workspace">
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderText}>
          <h1 className={styles.pageTitle}>タスク ガントチャート</h1>
          <p className={styles.pageSubtitle}>期日・依存・進捗をひとつのタイムラインで管理します。</p>
        </div>
        {caps.canWrite && (
          <Button iconLeft={<span aria-hidden>＋</span>} onClick={() => setCreating(true)} testId="fe4-create-open">
            タスク作成
          </Button>
        )}
      </header>

      <div className={styles.toolbar}>
        <TaskFilterBar
          value={filter}
          onChange={setFilter}
          onClear={() => setFilter(emptyFilter(eventId))}
          disabled={!caps.canRead}
        />
      </div>

      {store.lastError && (
        <div className={styles.banner} data-testid="fe4-error-banner">
          {store.lastError.message}
        </div>
      )}

      {filteredDto && (
        <GanttView
          dto={filteredDto}
          zoom="week"
          truncated={filteredDto.rows.length >= 2000}
          onReschedule={caps.canWrite ? onReschedule : undefined}
          onSelect={setSelected}
          statusById={statusById}
        />
      )}

      <TaskCreateModal
        open={creating}
        onClose={() => setCreating(false)}
        users={userList}
        dependencyOptions={tasks.map((t) => ({ id: t.id, title: t.title }))}
        onCreate={onCreate}
      />

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          users={userList}
          canWrite={caps.canWrite}
          canDelete={caps.canDelete}
          {...(fieldErrors ? { fieldErrors } : {})}
          onSave={onSaveDetail}
          onDelete={onDeleteDetail}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
