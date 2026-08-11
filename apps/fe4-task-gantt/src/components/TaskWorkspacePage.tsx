import { useEffect, useMemo, useState } from "react";
import type { task, common, identity } from "@dub/types";
import type { gantt as ganttNs } from "@dub/types";
import { Button } from "@dub/ui";
import { useApiClient } from "../api/client-context";
import { patchGanttRow, replaceDependencies, resolveUsers } from "../api/endpoints";
import { useGanttData } from "../api/useGanttData";
import { useTeams } from "../api/useTeams";
import { useTaskStore } from "../store/useTaskStore";
import { emptyFilter, toListTasksQuery, type TaskFilterState } from "../domain/task-query";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { taskCapabilities } from "../domain/permissions";
import { fieldErrorMap } from "../domain/error-mapping";
import { TaskFilterBar } from "./TaskFilterBar";
import { TeamViewSwitcher } from "./TeamViewSwitcher";
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
  const [createPresetDue, setCreatePresetDue] = useState<string | null>(null);
  const [createPresetDeps, setCreatePresetDeps] = useState<common.TaskId[]>([]);
  const [users, setUsers] = useState<UserCache>(() => createUserCache());
  const caps = useMemo(() => taskCapabilities(permissions), [permissions]);
  const gantt = useGanttData(eventId);
  const teams = useTeams().data ?? [];

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
  const assigneeNameById = useMemo(() => {
    const m = new Map<common.TaskId, string>();
    for (const t of tasks) {
      const name = t.assigneeId ? users.get(t.assigneeId)?.displayName : undefined;
      if (name) m.set(t.id, name);
    }
    return m;
  }, [tasks, users]);

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

  // Bar move/resize on the timeline: optimistically update the cache (bar jumps
  // the same tick as the drop), then persist the new schedule to the backend.
  const onSchedule = (id: common.TaskId, startsAt: common.ISODateTime, endsAt: common.ISODateTime) => {
    gantt.setRowScheduleOptimistic(id, startsAt, endsAt);
    void patchGanttRow(client, id, { startsAt, endsAt })
      .then(() => gantt.refetchFresh())
      .then(() => store.load(client, query))
      .catch(() => {
        void gantt.refetchFresh();
      });
  };

  const onCreateOnDate = (dueAt: common.ISODateTime | null) => {
    setCreatePresetDue(dueAt ? dueAt.slice(0, 10) : null);
    setCreatePresetDeps([]);
    setCreating(true);
  };

  // "＋ ここから子タスクを作成": open the create modal with this task preset as the
  // predecessor (parent). We also preset the child's due a few days after the
  // parent finishes, so it gets a bar and the parent->child dependency line is
  // actually drawn on the gantt (a bar-less row would hide the connector).
  const onCreateChild = (parentId: common.TaskId) => {
    const MS_PER_DAY = 86_400_000;
    const row = gantt.data?.rows.find((r) => r.taskId === parentId);
    const anchor = row?.endsAt ?? tasks.find((t) => t.id === parentId)?.dueAt ?? null;
    const childDue = anchor ? new Date(Date.parse(anchor) + 3 * MS_PER_DAY).toISOString().slice(0, 10) : null;
    setSelected(null);
    setCreatePresetDue(childDue);
    setCreatePresetDeps([parentId]);
    setCreating(true);
  };

  const onCreate = async (draft: TaskDraft) => {
    const created = await store.create(client, {
      eventId,
      title: draft.title,
      ...(draft.priority ? { priority: draft.priority } : {}),
      ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
      ...(draft.teamId ? { teamId: draft.teamId } : {}),
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
        {teams.length > 0 && (
          <TeamViewSwitcher
            teams={teams}
            value={filter.teamId}
            onChange={(teamId) => setFilter((f) => ({ ...f, ...(teamId ? { teamId } : { teamId: undefined }) }))}
            disabled={!caps.canRead}
          />
        )}
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
          onSchedule={caps.canWrite ? onSchedule : undefined}
          onSelect={setSelected}
          onCreateOnDate={caps.canWrite ? onCreateOnDate : undefined}
          statusById={statusById}
          assigneeNameById={assigneeNameById}
          canWrite={caps.canWrite}
        />
      )}

      <TaskCreateModal
        open={creating}
        initialDue={createPresetDue}
        initialDependsOn={createPresetDeps}
        onClose={() => {
          setCreating(false);
          setCreatePresetDue(null);
          setCreatePresetDeps([]);
        }}
        users={userList}
        teams={teams}
        dependencyOptions={tasks.map((t) => ({ id: t.id, title: t.title }))}
        onCreate={onCreate}
      />

      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          users={userList}
          teams={teams}
          canWrite={caps.canWrite}
          canDelete={caps.canDelete}
          {...(fieldErrors ? { fieldErrors } : {})}
          onSave={onSaveDetail}
          onDelete={onDeleteDetail}
          onCreateChild={onCreateChild}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
