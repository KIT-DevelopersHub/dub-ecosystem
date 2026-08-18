import { useEffect, useMemo, useState } from "react";
import type { task, common, identity } from "@dub/types";
import type { gantt as ganttNs } from "@dub/types";
import { Button, ErrorDialog, useToast } from "@dub/ui";
import type { ErrorDialogDetail } from "@dub/ui";
import { useUndoRedo, useUndoRedoHotkeys } from "@dub/app-ui";
import { useApiClient } from "../api/client-context";
import { getTask, patchGanttRow, replaceDependencies, resolveUsers, updateTask } from "../api/endpoints";
import { useGanttData } from "../api/useGanttData";
import { useTeams } from "../api/useTeams";
import { useRoster } from "../api/useRoster";
import { useTaskStore } from "../store/useTaskStore";
import { emptyFilter, toListTasksQuery, type TaskFilterState } from "../domain/task-query";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { taskCapabilities } from "../domain/permissions";
import { fieldErrorMap, errorSurface } from "../domain/error-mapping";
import { buildProvisionalTask, provisionalGanttRow, provisionalTaskId } from "../domain/provisional";
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

/** Human labels for validation `field` keys shown in the ErrorDialog breakdown. */
const FIELD_LABEL: Record<string, string> = {
  title: "タイトル",
  dueAt: "期日",
  startsAt: "開始日",
  endsAt: "終了日",
  status: "ステータス",
  priority: "優先度",
  assigneeId: "担当",
  teamId: "チーム",
  parentTaskId: "親タスク",
  dependsOnIds: "先行タスク",
  period: "期間",
};

/**
 * Gantt-only task workspace: a single self-drawn timeline with day/week/month
 * zoom, a working status filter, and full CRUD (create modal + detail-panel
 * edit/delete) wired through the optimistic store. The former list/board view
 * switch was removed — the gantt is the one canvas.
 */
export function TaskWorkspacePage({ eventId, permissions }: TaskWorkspacePageProps) {
  const client = useApiClient();
  const toast = useToast();
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
  // Org member roster — the source for the assignee dropdown. Without it the only
  // options were users ALREADY assigned to a task, so a fresh event showed just
  // "未割当" (bug 1b). Best-effort: an organizer lacking identity:read falls back
  // to the resolved-from-tasks list.
  const roster = useRoster().data ?? [];

  // Undo/redo (判断57). A reusable command stack (@dub/app-ui) — every state-
  // changing gantt action records its inverse, and Ctrl/⌘-Z reverses it. The
  // hotkey is off for read-only users and never steals a focused field's own undo.
  const history = useUndoRedo();
  useUndoRedoHotkeys(history, { enabled: caps.canWrite });

  // Load the WHOLE event: the gantt intersects its rows with this store set (see
  // `filteredDto`), so any task missing from the store silently vanishes from the
  // timeline. task-service caps `limit` at 200 (validate.ts throws on >200), so the
  // 216-task conference lost its tail — those rows disappeared and their edits were
  // impossible (F3). `store.loadAll` walks nextCursor to pull every page; 200 is the
  // per-page ceiling, not the total.
  const WORKSPACE_PAGE_LIMIT = 200;
  const query = useMemo(
    () => toListTasksQuery({ ...filter, limit: filter.limit ?? WORKSPACE_PAGE_LIMIT }),
    [filter],
  );

  useEffect(() => {
    void store.loadAll(client, query);
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
  // Assignee options = the org roster ∪ users resolved from existing assignments
  // (so an assignee no longer on the active roster still renders by name). Deduped
  // by id, roster first. This is what the create/detail 担当 dropdowns receive.
  const assignableUsers = useMemo<identity.UserSummary[]>(() => {
    const byId = new Map<common.UserId, identity.UserSummary>();
    for (const u of roster) byId.set(u.id, u);
    for (const u of userList) if (!byId.has(u.id)) byId.set(u.id, u);
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));
  }, [roster, userList]);
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

  // Inline field errors read from the RAW error detail (lastErrorDetail carries the
  // 400 `details`; the UX-routed lastError does not — the old cast always yielded
  // undefined, so inline field errors never rendered).
  const fieldErrors =
    store.lastError?.action === "field_errors"
      ? fieldErrorMap(store.lastErrorDetail?.details)
      : undefined;

  // Blocking ErrorDialog: shown for any failure whose reason the user cannot see
  // otherwise (save silently dropped, permission, dependency cycle, validation,
  // server/network). Auto-recovered cases (conflict-refetch, rate-limit) stay as a
  // quiet banner. This is what makes "なぜか保存されない" impossible again.
  const showErrorDialog = !!store.lastError && !!store.lastErrorDetail && errorSurface(store.lastError.action) === "dialog";
  const errorDialogDetails = useMemo<ErrorDialogDetail[]>(() => {
    const details = store.lastErrorDetail?.details;
    if (!Array.isArray(details)) return [];
    return details
      .filter((d): d is { field?: string; reason?: string; message?: string } => !!d && typeof d === "object")
      .map((d) => ({
        ...(d.field ? { label: FIELD_LABEL[d.field] ?? d.field } : {}),
        message: d.message ?? d.reason ?? "入力を確認してください",
      }));
  }, [store.lastErrorDetail]);
  const errorIsRetryable = store.lastError?.action === "retry_button";

  // ---- raw appliers (no history push) — the reversible primitives the undo
  //      commands re-issue. Each is an idempotent "set", so undo = apply the
  //      previous value and redo = apply the new one. ----

  // Persist one row's schedule (bar move/resize) optimistically, then to the API.
  const applyScheduleRaw = (id: common.TaskId, startsAt: common.ISODateTime, endsAt: common.ISODateTime) => {
    gantt.setRowScheduleOptimistic(id, startsAt, endsAt);
    return patchGanttRow(client, id, { startsAt, endsAt })
      .then(() => gantt.refetchFresh())
      .then(() => store.loadAll(client, query))
      .catch(() => {
        void gantt.refetchFresh();
      });
  };

  const MS_PER_DAY = 86_400_000;

  // Shift a parent + its whole subtree by whole days (children follow).
  const applyShiftRaw = (parentId: common.TaskId, deltaDays: number) => {
    // Read the LIVE cache, not gantt.data (a render-snapshot). Undo/redo commands
    // run long after they were recorded; a relative shift must apply to the bar's
    // CURRENT position or it overshoots (e.g. undoing a 2nd move from a stale base).
    const rows = gantt.currentRows();
    if (rows.length === 0 || deltaDays === 0) return Promise.resolve();
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
      .then(() => store.loadAll(client, query))
      .catch(() => {
        void gantt.refetchFresh();
      });
  };

  // Re-issue a task's field patch (optional) + WBS parent and/or predecessors as a
  // plain "set" (undo-safe). `undefined` parent/deps means "leave untouched"; `null`
  // parent detaches to top-level.
  //
  // The WHOLE save threads ONE fresh version read here (getTask), so field + parent +
  // dependency edits committed together can never send a stale, panel-cached version.
  // That is the root cause of the reparent→依存 bug: after 親→なし bumped the version,
  // a follow-up save carrying the panel's OLD version 409'd; re-reading here fixes it.
  // Both detail-pane save sub-paths (with or without a field change) funnel through
  // this single latest-version save.
  const applyRelationsRaw = async (
    id: common.TaskId,
    parentTaskId: common.TaskId | null | undefined,
    dependsOnIds: common.TaskId[] | undefined,
    fieldPatch?: task.UpdateTaskRequest,
  ) => {
    try {
      const cur = await getTask(client, id); // fresh version — the single source for this save
      let version = cur.version;
      // strip version/parentTaskId → the pure field changes (title/status/…); combine
      // them with the parent into ONE update so they share the just-read fresh version.
      const { version: _v, parentTaskId: _p, ...fields } = fieldPatch ?? ({} as task.UpdateTaskRequest);
      void _v;
      void _p;
      const hasFields = Object.keys(fields).length > 0;
      if (hasFields || parentTaskId !== undefined) {
        const body: task.UpdateTaskRequest = {
          version,
          ...fields,
          ...(parentTaskId !== undefined ? { parentTaskId } : {}),
        };
        const server = await updateTask(client, id, body);
        version = server.version;
      }
      if (dependsOnIds !== undefined) {
        await replaceDependencies(client, id, { version, dependsOnIds });
      }
    } catch (e) {
      // Previously this ran inside a `void (async …)()` with no catch, so a failed
      // parent/dependency save vanished silently ("保存を押しても無反応"). Surface it.
      store.reportError(e);
    } finally {
      await store.loadAll(client, query);
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
    // Optimistic create: show a provisional task + its bar on the timeline the same
    // tick, then reconcile with the server row (rolled back + surfaced on failure).
    const tempId = provisionalTaskId();
    const now = new Date().toISOString() as common.ISODateTime;
    const provisional = buildProvisionalTask(
      tempId,
      {
        title: draft.title,
        status: draft.status,
        priority: draft.priority,
        assigneeId: draft.assigneeId,
        teamId: draft.teamId,
        startAt: draft.startAt,
        dueAt: draft.dueAt,
        parentTaskId: draft.parentTaskId,
      },
      eventId,
      now,
    );
    gantt.upsertRowOptimistic(provisionalGanttRow(provisional, draft.parentTaskId));

    const created = await store.create(
      client,
      {
        eventId,
        title: draft.title,
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.assigneeId ? { assigneeId: draft.assigneeId } : {}),
        ...(draft.teamId ? { teamId: draft.teamId } : {}),
        ...(draft.startAt ? { startAt: draft.startAt } : {}),
        ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
        ...(draft.parentTaskId ? { parentTaskId: draft.parentTaskId } : {}),
      },
      provisional,
    );
    if (!created) {
      gantt.removeRowOptimistic(tempId); // create failed (reason already surfaced) — drop the provisional bar
      return false;
    }
    // Swap the provisional bar onto the real id so it stays visible (no flicker)
    // through the follow-up calls until the authoritative refetch replaces it.
    gantt.removeRowOptimistic(tempId);
    gantt.upsertRowOptimistic(provisionalGanttRow({ ...created }, draft.parentTaskId));

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
        // NOTE: the deps endpoint returns { taskId, dependsOnIds } (NOT a Task), so it
        // carries no version — do not read one off it. `version` is unused afterwards.
        await replaceDependencies(client, created.id, { version, dependsOnIds: draft.dependsOnIds });
      } catch (e) {
        // dependency cycle / out-of-scope — the task IS created; tell the user why
        // the dependency didn't take instead of dropping it on the floor.
        store.reportError(e);
      }
    }
    // "先行タスクを作成": add the new task as a predecessor of the source task. Fetch the
    // source task FRESH for its current version — the render-snapshot `tasks` list can be
    // stale (and, before F3, omitted tasks past #200 entirely), which sent a stale version
    // and 409'd: the task was created but linking errored ("作られるのにエラー").
    if (linkPredecessorFor) {
      try {
        const target = await getTask(client, linkPredecessorFor);
        const curDeps = gantt.data?.dependencies.filter((d) => d.toTaskId === linkPredecessorFor).map((d) => d.fromTaskId) ?? [];
        await replaceDependencies(client, linkPredecessorFor, {
          version: target.version,
          dependsOnIds: [...curDeps, created.id],
        });
      } catch (e) {
        store.reportError(e); // not-found / out-of-scope / cycle — surfaced; the new task still exists
      }
    }
    // The task IS created — confirm it to the user (楽観的UIと整合: ダイアログを閉じ
    // 成功トーストを出す). Reconciling reload/refetch runs after and must never turn a
    // successful create into a thrown error that keeps the modal open.
    toast.show({ kind: "success", title: "タスクを作成しました" });
    try {
      await store.loadAll(client, query);
      await gantt.refetchFresh();
    } catch {
      /* reconcile hiccup — the task exists; the next load/refetch will catch up */
    }
    return true;
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
    // Optimistic re-parent/detach: reflect the tree change the SAME tick so a child
    // set to 「なし」 leaves its parent immediately (was stuck in the toggle until the
    // server round-trip). applyRelationsRaw's refetch reconciles / restores on failure.
    if (relations.parentChanged) gantt.setRowParentOptimistic(id, relations.parentTaskId);
    // Field + parent + deps go through ONE fresh-version save (applyRelationsRaw re-reads
    // the version), so a field change committed alongside a relation edit can't 409 on a
    // stale panel version — the reparent→依存 failure class. (Field-ONLY edits keep the
    // fast optimistic path above.)
    void applyRelationsRaw(id, nextParent, nextDeps, hasFieldPatch ? fieldOnlyPatch : undefined);
    history.push({
      label: relations.depsChanged ? "先行タスク（依存）の変更" : "親タスク（親子）の変更",
      undo: () => applyRelationsRaw(id, relations.parentChanged ? prevParent : undefined, relations.depsChanged ? prevDeps : undefined),
      redo: () => applyRelationsRaw(id, nextParent, nextDeps),
    });
  };

  const onDeleteDetail = () => {
    if (!selectedTask) return;
    const id = selectedTask.id;
    // Optimistic: close the panel + drop the bar instantly; the store removes the
    // row immediately and restores it on failure (with the reason surfaced).
    setSelected(null);
    gantt.removeRowOptimistic(id);
    void store.removeTask(client, id).then(async (ok) => {
      if (ok) {
        await store.loadAll(client, query);
        await gantt.refetchFresh();
      } else {
        void gantt.refetchFresh(); // delete failed — restore the bar from the server
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

      {store.lastError && !showErrorDialog && (
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
        users={assignableUsers}
        teams={teams}
        parentOptions={allTaskOptions}
        scopeTasks={scopeTasks}
        onCreate={onCreate}
      />

      {selectedTask && (
        <TaskDetailPanel
          key={selectedTask.id}
          task={selectedTask}
          users={assignableUsers}
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

      {/* Blocking failure surface — the reason is always shown, never swallowed. */}
      {store.lastErrorDetail && (
        <ErrorDialog
          open={showErrorDialog}
          error={{
            code: store.lastErrorDetail.code,
            message: store.lastError?.message ?? store.lastErrorDetail.message,
            ...(store.lastErrorDetail.requestId ? { correlationId: store.lastErrorDetail.requestId } : {}),
          }}
          details={errorDialogDetails}
          onClose={() => store.clearError()}
          {...(errorIsRetryable
            ? {
                onRetry: () => {
                  store.clearError();
                  void store.loadAll(client, query);
                  void gantt.refetchFresh();
                },
              }
            : {})}
          testId="fe4-error-dialog"
        />
      )}
    </div>
  );
}
