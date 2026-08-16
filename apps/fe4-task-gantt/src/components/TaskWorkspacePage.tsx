import { useEffect, useMemo, useState } from "react";
import type { task, common, identity } from "@dub/types";
import type { gantt as ganttNs } from "@dub/types";
import { Button } from "@dub/ui";
import { useUndoRedo, useUndoRedoHotkeys } from "@dub/app-ui";
import { useApiClient } from "../api/client-context";
import { getTask, patchGanttRow, replaceDependencies, resolveUsers, updateTask } from "../api/endpoints";
import { useGanttData } from "../api/useGanttData";
import { useTeams } from "../api/useTeams";
import { useTaskStore } from "../store/useTaskStore";
import { emptyFilter, toListTasksQuery, type TaskFilterState } from "../domain/task-query";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { taskCapabilities } from "../domain/permissions";
import { fieldErrorMap } from "../domain/error-mapping";
import { scopeTasksFromRows, directParentOf } from "../domain/task-hierarchy";
import { TaskFilterBar } from "./TaskFilterBar";
import { TeamViewSwitcher } from "./TeamViewSwitcher";
import { GanttView } from "./GanttView";
import { TaskDetailPanel, type RelationEdit } from "./TaskDetailPanel";
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
  const [createPresetParent, setCreatePresetParent] = useState<common.TaskId | null>(null);
  const [createPresetDeps, setCreatePresetDeps] = useState<common.TaskId[]>([]);
  // When set, a task created from the modal is linked as this task's predecessor
  // ("先行タスクを作成" from the detail panel).
  const [createPredecessorFor, setCreatePredecessorFor] = useState<common.TaskId | null>(null);
  const [users, setUsers] = useState<UserCache>(() => createUserCache());
  const caps = useMemo(() => taskCapabilities(permissions), [permissions]);
  const gantt = useGanttData(eventId);
  const teams = useTeams().data ?? [];

  // Undo/redo (判断57). A reusable command stack (@dub/app-ui) — every state-
  // changing gantt action records its inverse, and Ctrl/⌘-Z reverses it. The
  // hotkey is off for read-only users and never steals a focused field's own undo.
  const history = useUndoRedo();
  useUndoRedoHotkeys(history, { enabled: caps.canWrite });

  // Load the whole event in one page: the gantt intersects its rows with this
  // store set (see `filteredDto`), so a short default page would silently drop
  // work-packages/leaves from the timeline. The WBS tree is ~170 rows.
  const WORKSPACE_PAGE_LIMIT = 500;
  const query = useMemo(
    () => toListTasksQuery({ ...filter, limit: filter.limit ?? WORKSPACE_PAGE_LIMIT }),
    [filter],
  );

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
  // team accent colour per task (team-grouped rows), and a legend of the teams
  // actually present on the board — drives the row stripe / bar cap / legend chips.
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t] as const)), [teams]);
  const teamColorById = useMemo(() => {
    const m = new Map<common.TaskId, string>();
    for (const t of tasks) {
      const color = t.teamId ? teamById.get(t.teamId)?.color : undefined;
      if (color) m.set(t.id, color);
    }
    return m;
  }, [tasks, teamById]);
  const teamLegend = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; color: string }[] = [];
    for (const t of tasks) {
      if (!t.teamId || seen.has(t.teamId)) continue;
      const team = teamById.get(t.teamId);
      if (team?.color) {
        seen.add(t.teamId);
        out.push({ id: team.id, name: team.name, color: team.color });
      }
    }
    return out;
  }, [tasks, teamById]);
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

  // Hierarchy/scope model over ALL rows (unfiltered by status) so parents and
  // same-scope siblings stay selectable even when a status filter hides some rows.
  const allRows = useMemo(() => gantt.data?.rows ?? [], [gantt.data]);
  const scopeTasks = useMemo(() => scopeTasksFromRows(allRows), [allRows]);
  const allTaskOptions = useMemo(
    () => allRows.map((r) => ({ id: r.taskId, title: r.title })),
    [allRows],
  );
  // predecessors currently on the selected task (先行タスク＝依存元 where to===selected).
  const selectedDependsOn = useMemo(() => {
    if (!selected || !gantt.data) return [] as common.TaskId[];
    return gantt.data.dependencies.filter((d) => d.toTaskId === selected).map((d) => d.fromTaskId);
  }, [selected, gantt.data]);
  const selectedParentId = useMemo(
    () => (selected ? directParentOf(scopeTasks, selected) : null),
    [selected, scopeTasks],
  );
  // parent options for the detail panel exclude the task itself.
  const detailParentOptions = useMemo(
    () => (selected ? allTaskOptions.filter((o) => o.id !== selected) : allTaskOptions),
    [allTaskOptions, selected],
  );

  const fieldErrors =
    store.lastError?.action === "field_errors"
      ? fieldErrorMap((store.lastError as unknown as { details?: unknown }).details)
      : undefined;

  // ---- raw appliers (no history push) — the reversible primitives the undo
  //      commands re-issue. Each is an idempotent "set", so undo = apply the
  //      previous value and redo = apply the new one. ----

  // Persist one row's schedule (bar move/resize) optimistically, then to the API.
  const applyScheduleRaw = (id: common.TaskId, startsAt: common.ISODateTime, endsAt: common.ISODateTime) => {
    gantt.setRowScheduleOptimistic(id, startsAt, endsAt);
    return patchGanttRow(client, id, { startsAt, endsAt })
      .then(() => gantt.refetchFresh())
      .then(() => store.load(client, query))
      .catch(() => {
        void gantt.refetchFresh();
      });
  };

  const MS_PER_DAY = 86_400_000;

  // Shift a parent + its whole subtree by whole days (children follow).
  const applyShiftRaw = (parentId: common.TaskId, deltaDays: number) => {
    if (!gantt.data || deltaDays === 0) return Promise.resolve();
    const rows = gantt.data.rows;
    // BFS the subtree (parent + all descendants at any depth).
    const ids: common.TaskId[] = [parentId];
    for (let i = 0; i < ids.length; i++) {
      for (const r of rows) if (r.parentTaskId === ids[i]) ids.push(r.taskId);
    }
    const shifts = ids
      .map((id) => rows.find((r) => r.taskId === id))
      .filter((r): r is NonNullable<typeof r> => !!r && !!r.startsAt && !!r.endsAt)
      .map((r) => ({
        id: r.taskId,
        startsAt: new Date(Date.parse(r.startsAt!) + deltaDays * MS_PER_DAY).toISOString() as common.ISODateTime,
        endsAt: new Date(Date.parse(r.endsAt!) + deltaDays * MS_PER_DAY).toISOString() as common.ISODateTime,
      }));
    for (const s of shifts) gantt.setRowScheduleOptimistic(s.id, s.startsAt, s.endsAt);
    return Promise.all(shifts.map((s) => patchGanttRow(client, s.id, { startsAt: s.startsAt, endsAt: s.endsAt })))
      .then(() => gantt.refetchFresh())
      .then(() => store.load(client, query))
      .catch(() => {
        void gantt.refetchFresh();
      });
  };

  // Re-issue a task's WBS parent and/or predecessors as a plain "set" (undo-safe).
  // `undefined` means "leave untouched"; `null` parent detaches to top-level.
  const applyRelationsRaw = async (
    id: common.TaskId,
    parentTaskId: common.TaskId | null | undefined,
    dependsOnIds: common.TaskId[] | undefined,
  ) => {
    try {
      const cur = await getTask(client, id); // fresh version (undo runs much later)
      let version = cur.version;
      if (parentTaskId !== undefined) {
        const server = await updateTask(client, id, { version, parentTaskId });
        version = server.version;
      }
      if (dependsOnIds !== undefined) {
        await replaceDependencies(client, id, { version, dependsOnIds });
      }
    } finally {
      await store.load(client, query);
      await gantt.refetchFresh();
    }
  };

  // ---- timeline bar edits (push an undo command around each raw apply) ----

  // Bar move/resize: record where the bar WAS so Ctrl-Z can snap it back.
  const onSchedule = (id: common.TaskId, startsAt: common.ISODateTime, endsAt: common.ISODateTime) => {
    const prev = gantt.data?.rows.find((r) => r.taskId === id);
    void applyScheduleRaw(id, startsAt, endsAt);
    if (prev?.startsAt && prev?.endsAt && (prev.startsAt !== startsAt || prev.endsAt !== endsAt)) {
      const prevStart = prev.startsAt, prevEnd = prev.endsAt;
      history.push({
        label: "バーの移動/リサイズ",
        undo: () => applyScheduleRaw(id, prevStart, prevEnd),
        redo: () => applyScheduleRaw(id, startsAt, endsAt),
      });
    }
  };

  // Parent drag-move (subtree shift): the inverse is simply the opposite shift.
  const onScheduleShift = (parentId: common.TaskId, deltaDays: number) => {
    if (deltaDays === 0) return;
    void applyShiftRaw(parentId, deltaDays);
    history.push({
      label: "親タスクの移動",
      undo: () => applyShiftRaw(parentId, -deltaDays),
      redo: () => applyShiftRaw(parentId, deltaDays),
    });
  };

  const openCreate = (opts: { due?: string | null; parent?: common.TaskId | null; deps?: common.TaskId[]; predecessorFor?: common.TaskId | null }) => {
    setCreatePresetDue(opts.due ?? null);
    setCreatePresetParent(opts.parent ?? null);
    setCreatePresetDeps(opts.deps ?? []);
    setCreatePredecessorFor(opts.predecessorFor ?? null);
    setCreating(true);
  };

  const closeCreate = () => {
    setCreating(false);
    setCreatePresetDue(null);
    setCreatePresetParent(null);
    setCreatePresetDeps([]);
    setCreatePredecessorFor(null);
  };

  const onCreateOnDate = (dueAt: common.ISODateTime | null) => {
    openCreate({ due: dueAt ? dueAt.slice(0, 10) : null });
  };

  // "＋ 子タスクを作成": open the create modal with this task preset as the PARENT
  // (真の親子関係). The child's due is a few days after the parent's end so it gets
  // a bar and the rollup visibly extends the parent.
  const onCreateChild = (parentId: common.TaskId) => {
    const row = gantt.data?.rows.find((r) => r.taskId === parentId);
    const anchor = row?.endsAt ?? tasks.find((t) => t.id === parentId)?.dueAt ?? null;
    const childDue = anchor ? new Date(Date.parse(anchor) + 3 * MS_PER_DAY).toISOString().slice(0, 10) : null;
    setSelected(null);
    openCreate({ due: childDue, parent: parentId });
  };

  // "＋ 先行タスクを作成": create a new task in the SAME SCOPE as this one (same
  // direct parent → sibling, so the dependency is in-scope per 判断10), then link
  // it as this task's predecessor. Preset the new task's due before this task's
  // start so the connector reads left→right.
  const onCreatePredecessor = (taskId: common.TaskId) => {
    const row = gantt.data?.rows.find((r) => r.taskId === taskId);
    const start = row?.startsAt ?? tasks.find((t) => t.id === taskId)?.dueAt ?? null;
    const predDue = start ? new Date(Date.parse(start) - 2 * MS_PER_DAY).toISOString().slice(0, 10) : null;
    const parent = directParentOf(scopeTasks, taskId);
    setSelected(null);
    openCreate({ due: predDue, parent, predecessorFor: taskId });
  };

  const onCreate = async (draft: TaskDraft) => {
    const linkPredecessorFor = createPredecessorFor;
    const created = await store.create(client, {
      eventId,
      title: draft.title,
      ...(draft.priority ? { priority: draft.priority } : {}),
      ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
      ...(draft.teamId ? { teamId: draft.teamId } : {}),
      ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
      ...(draft.parentTaskId ? { parentTaskId: draft.parentTaskId } : {}),
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
        /* dependency cycle / out-of-scope etc. — task is still created; surfaced separately */
      }
    }
    // "先行タスクを作成": add the new task as a predecessor of the source task.
    if (linkPredecessorFor) {
      const target = tasks.find((t) => t.id === linkPredecessorFor);
      if (target) {
        const curDeps = gantt.data?.dependencies.filter((d) => d.toTaskId === linkPredecessorFor).map((d) => d.fromTaskId) ?? [];
        try {
          await replaceDependencies(client, linkPredecessorFor, {
            version: target.version,
            dependsOnIds: [...curDeps, created.id],
          });
        } catch {
          /* out-of-scope / cycle — surfaced separately; the new task still exists */
        }
      }
    }
    await store.load(client, query);
    await gantt.refetchFresh();
  };

  const onSaveDetail = (patch: task.UpdateTaskRequest, relations: RelationEdit) => {
    if (!selectedTask) return;
    const needsRelations = relations.parentChanged || relations.depsChanged;
    // Field-only edit (title/status/…): keep the optimistic fast-path. Field edits
    // are not in the undo history yet — see the PR notes (需要があれば拡張).
    const { parentTaskId: _p, ...fieldOnlyPatch } = patch;
    const hasFieldPatch = Object.keys(fieldOnlyPatch).some((k) => k !== "version");
    if (!needsRelations) {
      void store
        .patchOptimistic(client, selectedTask.id, fieldOnlyPatch, selectedTask.version, fieldOnlyPatch)
        .then((ok) => {
          if (ok) void gantt.refetchFresh();
        });
      return;
    }
    // Relation edit (親子 / 依存). Snapshot the BEFORE state so Ctrl-Z can restore
    // the previous parent/predecessors, apply the AFTER state, then record it.
    const id = selectedTask.id;
    const prevParent = selectedParentId;
    const prevDeps = selectedDependsOn;
    const nextParent = relations.parentChanged ? relations.parentTaskId : undefined;
    const nextDeps = relations.depsChanged ? relations.dependsOnIds : undefined;
    void (async () => {
      if (hasFieldPatch) {
        // apply the field changes first (own optimistic path), then the relations.
        await store.patchOptimistic(client, id, fieldOnlyPatch, selectedTask.version, fieldOnlyPatch);
      }
      await applyRelationsRaw(id, nextParent, nextDeps);
    })();
    history.push({
      label: relations.depsChanged ? "先行タスク（依存）の変更" : "親タスク（親子）の変更",
      undo: () => applyRelationsRaw(id, relations.parentChanged ? prevParent : undefined, relations.depsChanged ? prevDeps : undefined),
      redo: () => applyRelationsRaw(id, nextParent, nextDeps),
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
          <div className={styles.headerActions}>
            {/* Organizer edit affordance. Placeholder gating today: canWrite comes
                from effectivePermissions (task:write). Wire the real organizer role
                by mapping the org role -> task:write in permissions.ts later. */}
            <span className={styles.roleBadge} title="編集できるのはチームのオーガナイザーです（権限は後日 role と接続）" data-testid="fe4-organizer-badge">
              オーガナイザー編集
            </span>
            <div className={styles.undoRedo} role="group" aria-label="元に戻す / やり直す">
              <button
                type="button"
                className={styles.undoBtn}
                onClick={() => void history.undo()}
                disabled={!history.canUndo}
                title={`元に戻す${history.undoLabel ? `: ${history.undoLabel}` : ""}（Ctrl/⌘+Z）`}
                aria-label="元に戻す"
                data-testid="fe4-undo"
              >
                ↶<span className={styles.undoBtnLabel}>元に戻す</span>
              </button>
              <button
                type="button"
                className={styles.undoBtn}
                onClick={() => void history.redo()}
                disabled={!history.canRedo}
                title={`やり直す${history.redoLabel ? `: ${history.redoLabel}` : ""}（Ctrl/⌘+Shift+Z）`}
                aria-label="やり直す"
                data-testid="fe4-redo"
              >
                ↷
              </button>
            </div>
            <Button iconLeft={<span aria-hidden>＋</span>} onClick={() => setCreating(true)} testId="fe4-create-open">
              タスク作成
            </Button>
          </div>
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
          onScheduleShift={caps.canWrite ? onScheduleShift : undefined}
          onSelect={setSelected}
          onCreateOnDate={caps.canWrite ? onCreateOnDate : undefined}
          statusById={statusById}
          assigneeNameById={assigneeNameById}
          teamColorById={teamColorById}
          teamLegend={teamLegend}
          canWrite={caps.canWrite}
        />
      )}

      <TaskCreateModal
        open={creating}
        initialDue={createPresetDue}
        initialParentId={createPresetParent}
        initialDependsOn={createPresetDeps}
        onClose={closeCreate}
        users={userList}
        teams={teams}
        parentOptions={allTaskOptions}
        scopeTasks={scopeTasks}
        onCreate={onCreate}
      />

      {selectedTask && (
        <TaskDetailPanel
          key={selectedTask.id}
          task={selectedTask}
          users={userList}
          teams={teams}
          canWrite={caps.canWrite}
          canDelete={caps.canDelete}
          parentOptions={detailParentOptions}
          parentTaskId={selectedParentId}
          scopeTasks={scopeTasks}
          dependsOnIds={selectedDependsOn}
          {...(fieldErrors ? { fieldErrors } : {})}
          onSave={onSaveDetail}
          onDelete={onDeleteDetail}
          onCreateChild={onCreateChild}
          onCreatePredecessor={onCreatePredecessor}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
