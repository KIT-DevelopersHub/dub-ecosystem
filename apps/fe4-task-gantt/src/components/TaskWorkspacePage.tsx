import { useEffect, useMemo, useRef, useState } from "react";
import type { task, common, identity } from "@dub/types";
import type { gantt as ganttNs } from "@dub/types";
import { Button, ErrorDialog, useToast } from "@dub/ui";
import type { ErrorDialogDetail } from "@dub/ui";
import { useUndoRedo, useUndoRedoHotkeys } from "@dub/app-ui";
import { useApiClient } from "../api/client-context";
import { getTask, patchGanttRow, replaceDependencies, resolveUsers, updateTask } from "../api/endpoints";
import { useGanttData } from "../api/useGanttData";
import { useGanttView } from "../api/useGanttView";
import { useTeams } from "../api/useTeams";
import { useRoster } from "../api/useRoster";
import { useTaskStore } from "../store/useTaskStore";
import type { OptimisticPatch } from "../domain/task-store";
import { emptyFilter, toListTasksQuery, type TaskFilterState } from "../domain/task-query";
import { createUserCache, ensureUsers, type UserCache } from "../domain/user-cache";
import { taskCapabilities } from "../domain/permissions";
import { fieldErrorMap, errorSurface } from "../domain/error-mapping";
import { buildProvisionalTask, provisionalGanttRow, provisionalTaskId } from "../domain/provisional";
import { scopeTasksFromRows, directParentOf } from "../domain/task-hierarchy";
import { rollupRowDates, scaleChildrenForParentResize } from "../domain/timeline-axis";
import { applyManualOrder, reorderWithinSiblings } from "../domain/row-order";
import { sortRows, type SortContext } from "../domain/row-sort";
import type { RowGroup } from "../domain/row-groups";
import { PRIORITY_LABEL } from "../domain/task-form";
import { useGanttSortMode } from "../domain/gantt-sort-pref";
import { computeTaskNumbers, MAX_PAD_WIDTH } from "../domain/task-number";
import { useTaskNumberPrefix, useTaskNumberPadWidth, useTaskNumberVisible } from "../domain/task-number-pref";
import { useWriteFeedback } from "../domain/write-feedback";
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

// Solid fill colours for the sort-group brackets (@dub/tokens hex). Priorities map to
// the semantic scales (緊急=danger / 高=warning / 中=info / 低=gray); the neutral is
// gray.500, used for team-less rows. GanttView overlays a WCAG-legible text colour.
const PRIORITY_GROUP_COLOR: Record<task.TaskPriority, string> = {
  urgent: "#d92d20", // danger.600
  high: "#dc6803", // warning.600
  medium: "#1570ef", // info.600
  low: "#6f7a90", // gray.500
};
const NEUTRAL_GROUP_COLOR = "#6f7a90"; // gray.500

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
  const feedback = useWriteFeedback();
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
  // Per-user view state — carries the personal manual row order (drag reorder).
  const view = useGanttView(eventId);
  const orderedTaskIds = useMemo(() => view.data?.orderedTaskIds ?? [], [view.data]);
  // Row 並び替え mode (手動/重要度/時期/チーム). Personal client-side view preference,
  // persisted per-event in localStorage; "手動" falls back to the drag order overlay.
  const [sortMode, setSortMode] = useGanttSortMode(eventId);
  // Task-number prefix (e.g. "AA") + zero-pad width (e.g. 4 -> "AA-0001") — personal
  // view settings, persisted per event.
  const [numberPrefix, setNumberPrefix] = useTaskNumberPrefix(eventId);
  const [numberPadWidth, setNumberPadWidth] = useTaskNumberPadWidth(eventId);
  // Show/hide the task-number badge (default ON). OFF hides the badges and the
  // prefix/桁数 inputs, but keeps their saved values for when it's turned back on.
  const [numberVisible, setNumberVisible] = useTaskNumberVisible(eventId);
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
  // Coalesce the "nothing to undo/redo" notice so a held-down ⌘Z on an empty stack
  // (which returns synchronously — no API round-trip to rate-limit it) can't spam the
  // toast. A successful undo/redo awaits its API inverse, so those are naturally paced.
  const lastBoundaryToast = useRef(0);
  const notifyBoundary = (message: string) => {
    const now = Date.now();
    if (now - lastBoundaryToast.current < 1500) return;
    lastBoundaryToast.current = now;
    toast.show({ kind: "info", title: message });
  };
  // Run undo/redo AND tell the user what happened (判断: 戻した/やり直したのが見えるように).
  // Reads the label of the command about to be reversed (undoLabel/redoLabel) so the
  // toast names the operation ("並び替えを元に戻しました"); falls back to a generic line.
  // Both the hotkeys and the header buttons route through these, so the copy is one place.
  const runUndo = async (): Promise<boolean> => {
    const label = history.undoLabel;
    const ok = await history.undo();
    if (ok) toast.show({ kind: "info", title: label ? `${label}を元に戻しました` : "元に戻しました" });
    else notifyBoundary("これ以上戻せません");
    return ok;
  };
  const runRedo = async (): Promise<boolean> => {
    const label = history.redoLabel;
    const ok = await history.redo();
    if (ok) toast.show({ kind: "info", title: label ? `${label}をやり直しました` : "やり直しました" });
    else notifyBoundary("これ以上やり直せません");
    return ok;
  };
  useUndoRedoHotkeys({ undo: runUndo, redo: runRedo }, { enabled: caps.canWrite });

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

  // Per-task grouping descriptor for the sort-bracket rail. Only チーム順 / 重要度順 group
  // into visible ranges; 手動・時期 pass undefined so no brackets render. Team-less rows
  // fall into a "チーム未設定" run so every row is accounted for. Every group carries a
  // solid fill colour (team colour / priority colour / a neutral) — the bracket fills
  // with it and GanttView picks a WCAG-legible text colour on top. Read-only overlay.
  const rowGroupById = useMemo<ReadonlyMap<common.TaskId, RowGroup> | undefined>(() => {
    if (sortMode === "team") {
      const m = new Map<common.TaskId, RowGroup>();
      for (const t of tasks) {
        const team = t.teamId ? teamById.get(t.teamId) : undefined;
        if (team) m.set(t.id, { key: team.id, label: team.name, color: team.color || NEUTRAL_GROUP_COLOR });
        else m.set(t.id, { key: "__noteam__", label: "チーム未設定", color: NEUTRAL_GROUP_COLOR });
      }
      return m;
    }
    if (sortMode === "priority") {
      const m = new Map<common.TaskId, RowGroup>();
      for (const t of tasks) m.set(t.id, { key: t.priority, label: PRIORITY_LABEL[t.priority], color: PRIORITY_GROUP_COLOR[t.priority] });
      return m;
    }
    return undefined;
  }, [sortMode, tasks, teamById]);

  // Sort context for the automatic 並び替え modes (重要度/時期/チーム). priority already
  // lives on task.Task (no schema change); team order = the order member-service
  // returns teams in (useTeams). All read-only overlays — nothing is persisted.
  const sortContext = useMemo<SortContext>(() => {
    const priorityById = new Map(tasks.map((t) => [t.id, t.priority] as const));
    const teamIdById = new Map(tasks.map((t) => [t.id, t.teamId ?? null] as const));
    const teamOrder = new Map(teams.map((t, i) => [t.id, i] as const));
    return { priorityById, teamIdById, teamOrder };
  }, [tasks, teams]);

  // The status filter narrows the gantt: keep only rows whose task is in the
  // (server-filtered) store set, and dependencies between two visible tasks.
  const filteredDto = useMemo<ganttNs.GanttChartDTO | null>(() => {
    if (!gantt.data) return null;
    const visible = new Set(tasks.map((t) => t.id));
    const base = gantt.data.rows.filter((r) => visible.has(r.taskId));
    // "手動": apply the per-user drag overlay (siblings only, parent→children
    // contiguity preserved). Otherwise: apply the chosen automatic sort. Both keep
    // the WBS hierarchy intact (only re-sort within each sibling group).
    const rows = sortMode === "manual" ? applyManualOrder(base, orderedTaskIds) : sortRows(base, sortMode, sortContext);
    return {
      ...gantt.data,
      rows,
      dependencies: gantt.data.dependencies.filter((d) => visible.has(d.fromTaskId) && visible.has(d.toTaskId)),
      criticalTaskIds: (gantt.data.criticalTaskIds ?? []).filter((id) => visible.has(id)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gantt.data, tasks, orderedTaskIds, sortMode, sortContext]);

  // WBS task numbers (e.g. "AA-1-1"), derived from the CURRENT display order + the
  // WBS tree on each row, so re-ordering / re-parenting re-numbers automatically. It
  // is computed over the exact rows the gantt renders (filtered + sorted), so the
  // badges match what's on screen. View-time only — nothing persisted.
  const numberById = useMemo<ReadonlyMap<common.TaskId, string>>(
    () => (filteredDto && numberVisible ? computeTaskNumbers(filteredDto.rows, numberPrefix, numberPadWidth) : new Map()),
    [filteredDto, numberVisible, numberPrefix, numberPadWidth],
  );

  const selectedTask = selected ? tasks.find((t) => t.id === selected) ?? null : null;
  // The selected task's DISPLAYED bar window (derived by the gantt read model). Seeds the
  // detail 開始日/期日 when the task's own startAt/dueAt columns are null, so the panel value
  // equals the bar and the axis (値=バー=横軸) even for a derived-start task (real data
  // seeds only dueAt — start_at is null until first edited).
  const selectedRow = useMemo(
    () => (selected ? gantt.data?.rows.find((r) => r.taskId === selected) ?? null : null),
    [selected, gantt.data],
  );

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
      .catch((e) => {
        // Previously swallowed — a failed bar move silently reverted with no reason.
        // Surface it (error toast) and refetch to restore the true position.
        feedback.failure(e, "予定の保存に失敗しました");
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
      .catch((e) => {
        feedback.failure(e, "予定の保存に失敗しました");
        void gantt.refetchFresh();
      });
  };

  // Optimistically apply, then persist, a SET of explicit child schedules (used by the
  // parent-bar resize and its undo/redo — each is an idempotent "set" of absolute dates).
  const applyChildScheduleSet = (
    set: ReadonlyArray<{ id: common.TaskId; startsAt: common.ISODateTime; endsAt: common.ISODateTime }>,
  ): Promise<void> => {
    if (set.length === 0) return Promise.resolve();
    for (const s of set) gantt.setRowScheduleOptimistic(s.id, s.startsAt, s.endsAt);
    return Promise.all(set.map((s) => patchGanttRow(client, s.id, { startsAt: s.startsAt, endsAt: s.endsAt })))
      .then(() => gantt.refetchFresh())
      .then(() => store.loadAll(client, query))
      .catch((e) => {
        feedback.failure(e, "予定の保存に失敗しました");
        void gantt.refetchFresh();
      });
  };

  // Resize a work-package (parent) BAR at one edge. A parent's span is the rollup of its
  // children (the read model returns the parent's own dates as null), so we cannot persist
  // the parent's own row — the next GET discards it and the bar snaps back ("親バーを伸ばし
  // ても反映されない"). Instead we SCALE the dated descendants about the opposite edge so the
  // rolled span reaches the dragged edge; those child writes persist and roll the parent bar
  // up to match. Undo restores the children's EXACT prior dates (scaling has no clean day-
  // aligned inverse), so Ctrl-Z is one step.
  const onParentResize = (parentId: common.TaskId, edge: "start" | "end", deltaDays: number) => {
    if (deltaDays === 0) return;
    const rows = gantt.currentRows();
    const parent = rollupRowDates(rows).find((r) => r.taskId === parentId);
    if (!parent?.startsAt || !parent?.endsAt) return;
    // BFS the subtree to collect every descendant (any depth).
    const ids: common.TaskId[] = [parentId];
    for (let i = 0; i < ids.length; i++) for (const r of rows) if (r.parentTaskId === ids[i]) ids.push(r.taskId);
    const descendants = ids
      .slice(1)
      .map((id) => rows.find((r) => r.taskId === id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ taskId: r.taskId, startsAt: r.startsAt ?? null, endsAt: r.endsAt ?? null }));
    const scaled = scaleChildrenForParentResize(
      { startsAt: parent.startsAt, endsAt: parent.endsAt },
      descendants,
      edge,
      deltaDays,
    );
    if (scaled.length === 0) return;
    const after = scaled.map((s) => ({
      id: s.taskId as common.TaskId,
      startsAt: s.startsAt as common.ISODateTime,
      endsAt: s.endsAt as common.ISODateTime,
    }));
    // Snapshot the children's CURRENT dates so undo restores them exactly.
    const before = after
      .map(({ id }) => rows.find((r) => r.taskId === id))
      .filter((r): r is NonNullable<typeof r> => !!r && !!r.startsAt && !!r.endsAt)
      .map((r) => ({ id: r.taskId, startsAt: r.startsAt!, endsAt: r.endsAt! }));
    void applyChildScheduleSet(after);
    history.push({
      label: "まとめ行のリサイズ",
      undo: () => applyChildScheduleSet(before),
      redo: () => applyChildScheduleSet(after),
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
  //
  // Best-effort background re-sync (task cache + gantt DTO) used AFTER a write has
  // already succeeded; it NEVER surfaces an error — the write is committed, so a failing
  // reconcile just retries and converges, never a false save failure.
  const reconcileRelations = async () => {
    try {
      await store.reconcile(client, query);
      await gantt.refetchFresh();
    } catch {
      /* stay silent; the next user action or refetch will converge */
    }
  };

  const applyRelationsRaw = async (
    id: common.TaskId,
    parentTaskId: common.TaskId | null | undefined,
    dependsOnIds: common.TaskId[] | undefined,
    fieldPatch?: task.UpdateTaskRequest,
  ): Promise<boolean> => {
    // Snapshot the BEFORE state from the LIVE cache so a failure snaps back the same
    // tick — no waiting on the reconciling refetch (the "追加/削除しても時差があって
    // 失敗したか不安" complaint). undefined = "this facet is untouched, don't roll it".
    const snapParent =
      parentTaskId !== undefined ? gantt.currentRows().find((r) => r.taskId === id)?.parentTaskId ?? null : undefined;
    const snapDeps =
      dependsOnIds !== undefined
        ? gantt.currentDependencies().filter((d) => d.toTaskId === id).map((d) => d.fromTaskId)
        : undefined;
    // Optimistic: reflect the parent (親子) AND the predecessor (先行＝依存) edges the
    // SAME tick the user saves, before the persist round-trip resolves.
    if (parentTaskId !== undefined) gantt.setRowParentOptimistic(id, parentTaskId);
    if (dependsOnIds !== undefined) gantt.setDependenciesOptimistic(id, dependsOnIds);

    // ---- WRITE. ONLY a failure of the mutation calls themselves (getTask / updateTask /
    //      replaceDependencies) is a real save failure: roll the optimistic edit back and
    //      surface the reason. The post-write reconcile is deliberately OUTSIDE this try —
    //      see below. ----
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
      // The WRITE itself failed — snap the optimistic parent/deps back at once, then
      // surface the reason (before #301 the change ran with no catch and vanished
      // silently, "保存を押しても無反応").
      if (snapParent !== undefined) gantt.setRowParentOptimistic(id, snapParent);
      if (snapDeps !== undefined) gantt.setDependenciesOptimistic(id, snapDeps);
      store.reportError(e);
      // reconcile in the background so the cache re-converges on the server truth.
      void reconcileRelations();
      return false;
    }

    // ---- WRITE SUCCEEDED (the server accepted the edit). Reconcile with authoritative
    //      state, but a failure of this READ must NEVER roll the committed edit back nor
    //      raise an error. THAT false rollback was the "先行タスクを外すとエラーが出るが、
    //      少し時間を置くと外れている" bug: the post-write refetch (`refetchFresh`) threw and
    //      the already-persisted removal got reverted + an error toast shown, then the
    //      background reconcile re-applied it a moment later. Keep the optimistic (now
    //      authoritative) state and converge quietly; retry in the background if the read
    //      fails. ----
    let reconciled = await store.reconcile(client, query);
    try {
      await gantt.refetchFresh();
    } catch {
      reconciled = false;
    }
    if (!reconciled) void reconcileRelations(); // one background retry; converges quietly
    return true;
  };

  // Re-issue a field-only patch (title/status/優先度/担当/チーム/開始日/期日) as a plain
  // "set" — the reversible primitive an undo/redo command re-runs. It reads a FRESH
  // version (getTask) first, so a DEFERRED undo/redo (run long after the edit, once the
  // task's version has moved on) can never 409 on a stale panel-cached version — the
  // same latest-version discipline applyRelationsRaw uses. Optimistic through the store
  // (snappy), then refetch so any date change re-flows onto the bar.
  const applyFieldPatchRaw = async (
    id: common.TaskId,
    fields: OptimisticPatch["changes"],
  ): Promise<boolean> => {
    if (Object.keys(fields).length === 0) return true;
    try {
      const cur = await getTask(client, id); // fresh version — deferred-undo safe
      const body: task.UpdateTaskRequest = { ...fields, version: cur.version };
      const ok = await store.patchOptimistic(client, id, fields, cur.version, body);
      if (ok) void gantt.refetchFresh();
      return !!ok;
    } catch (e) {
      store.reportError(e);
      return false;
    }
  };

  // Persist a manual row order (drag reorder) — the reversible primitive for the
  // reorder undo/redo. Quiet on success (undo/redo shouldn't toast "更新しました"); the
  // view hook already rolls its cache back and we surface a failure.
  const applyOrderRaw = (order: common.TaskId[]): Promise<unknown> =>
    view.saveOrder(order).catch((e) => feedback.failure(e, "並び順の保存に失敗しました"));

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
    // Field-only edit (title/status/優先度/担当/チーム/開始日/期日): keep the optimistic
    // fast-path AND record it for undo/redo. Snapshot the BEFORE value of each changed
    // field from the current task so Ctrl/⌘-Z restores exactly those fields.
    const { parentTaskId: _p, ...fieldOnlyPatch } = patch;
    const hasFieldPatch = Object.keys(fieldOnlyPatch).some((k) => k !== "version");
    if (!needsRelations) {
      const id = selectedTask.id;
      const before = selectedTask;
      // Snapshot the BEFORE value of each changed field so Ctrl/⌘-Z restores exactly them.
      const afterFields: OptimisticPatch["changes"] = {};
      const beforeFields: OptimisticPatch["changes"] = {};
      for (const k of Object.keys(fieldOnlyPatch)) {
        if (k === "version") continue;
        (afterFields as Record<string, unknown>)[k] = (fieldOnlyPatch as Record<string, unknown>)[k];
        // absent (e.g. never-set 開始日) restores to null, the API's "clear" value.
        (beforeFields as Record<string, unknown>)[k] = (before as unknown as Record<string, unknown>)[k] ?? null;
      }
      // Optimistically move the timeline bar the SAME tick the user saves a 開始日/期日
      // change (optimistic-UI). The detail panel edits task.startAt/dueAt, which map
      // onto the gantt row's startsAt/endsAt (startsAt↔startAt, endsAt↔dueAt). Without
      // this the bar only moved once the post-save refetch resolved — and stayed on the
      // OLD position if that refetch lagged or the read-model was stale ("変えても反映
      // されない/古いまま"). refetchFresh() then reconciles to the authoritative window.
      const changesDates =
        fieldOnlyPatch.startAt !== undefined || fieldOnlyPatch.dueAt !== undefined;
      const barBefore = changesDates
        ? gantt.currentRows().find((r) => r.taskId === id)
        : undefined;
      if (changesDates) {
        const nextStarts =
          fieldOnlyPatch.startAt !== undefined ? fieldOnlyPatch.startAt : barBefore?.startsAt ?? null;
        const nextEnds =
          fieldOnlyPatch.dueAt !== undefined ? fieldOnlyPatch.dueAt : barBefore?.endsAt ?? null;
        gantt.setRowScheduleOptimistic(id, nextStarts, nextEnds);
      }
      void store
        .patchOptimistic(client, id, fieldOnlyPatch, selectedTask.version, fieldOnlyPatch)
        .then((ok) => {
          if (ok) {
            void gantt.refetchFresh();
            feedback.success();
          } else if (changesDates) {
            // Save failed (reason surfaced by the store) — restore the true bar position.
            void gantt.refetchFresh();
          }
        });
      if (Object.keys(afterFields).length > 0) {
        history.push({
          label: "タスクの編集",
          undo: async () => {
            await applyFieldPatchRaw(id, beforeFields);
          },
          redo: async () => {
            await applyFieldPatchRaw(id, afterFields);
          },
        });
      }
      return;
    }
    // Relation edit (親子 / 依存). Snapshot the BEFORE state so Ctrl-Z can restore
    // the previous parent/predecessors, apply the AFTER state, then record it.
    const id = selectedTask.id;
    const prevParent = selectedParentId;
    const prevDeps = selectedDependsOn;
    const nextParent = relations.parentChanged ? relations.parentTaskId : undefined;
    const nextDeps = relations.depsChanged ? relations.dependsOnIds : undefined;
    // Field + parent + deps go through ONE fresh-version save (applyRelationsRaw re-reads
    // the version), so a field change committed alongside a relation edit can't 409 on a
    // stale panel version — the reparent→依存 failure class. The optimistic parent + 依存
    // reflection (and its rollback) now lives INSIDE applyRelationsRaw, so save + undo +
    // redo all reflect instantly. On success we confirm with a success toast.
    void applyRelationsRaw(id, nextParent, nextDeps, hasFieldPatch ? fieldOnlyPatch : undefined).then((ok) => {
      if (ok) feedback.success();
    });
    history.push({
      label: relations.depsChanged ? "先行タスク（依存）の変更" : "親タスク（親子）の変更",
      undo: async () => {
        await applyRelationsRaw(id, relations.parentChanged ? prevParent : undefined, relations.depsChanged ? prevDeps : undefined);
      },
      redo: async () => {
        await applyRelationsRaw(id, nextParent, nextDeps);
      },
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
        feedback.success("タスクを削除しました");
        await store.loadAll(client, query);
        await gantt.refetchFresh();
      } else {
        void gantt.refetchFresh(); // delete failed — restore the bar (reason surfaced by the store)
      }
    });
  };

  // ---- drag reorder (左ペインのタスクをドラッグで並べ替え) ----
  // A personal, per-user manual order persisted in the gantt view state
  // (orderedTaskIds). Optimistic: the list re-sequences the same tick (the rows are
  // re-derived from the view state — see filteredDto); success/failure toast; the
  // view hook rolls the order back in cache on a failed PUT. Only same-parent moves
  // are honoured (re-parenting stays an explicit detail-panel action).
  const onReorder = (draggedId: common.TaskId, beforeTaskId: common.TaskId | null) => {
    // Compute against the CURRENTLY DISPLAYED order (server rows + the manual overlay),
    // so a second drag builds on the first rather than the raw server sequence.
    const displayed = applyManualOrder(gantt.currentRows(), orderedTaskIds);
    const nextOrder = reorderWithinSiblings(displayed, draggedId, beforeTaskId);
    if (!nextOrder) return; // cross-parent drop or no-op
    // Snapshot the FULL current order (not the possibly-partial orderedTaskIds overlay)
    // so undo pins the exact pre-drag arrangement — and redo re-applies the new one.
    const prevOrder = displayed.map((r) => r.taskId);
    void view
      .saveOrder(nextOrder)
      .then(() => feedback.success("並び順を更新しました"))
      .catch((e) => feedback.failure(e, "並び順の保存に失敗しました"));
    history.push({
      label: "タスクの並び替え",
      undo: async () => {
        await applyOrderRaw(prevOrder);
      },
      redo: async () => {
        await applyOrderRaw(nextOrder);
      },
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
                onClick={() => void runUndo()}
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
                onClick={() => void runRedo()}
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
        <label className={styles.numToggle}>
          <input
            type="checkbox"
            className={styles.numToggleInput}
            checked={numberVisible}
            onChange={(e) => setNumberVisible(e.target.checked)}
            aria-label="タスク番号を表示"
            data-testid="fe4-number-visible"
          />
          <span className={styles.numPrefixLabel}>タスク番号を表示</span>
        </label>
        {numberVisible && (
          <>
            <label className={styles.numPrefix}>
              <span className={styles.numPrefixLabel}>番号プレフィックス</span>
              <input
                type="text"
                className={styles.numPrefixInput}
                value={numberPrefix}
                onChange={(e) => setNumberPrefix(e.target.value)}
                maxLength={8}
                placeholder="AA"
                aria-label="タスク番号のプレフィックス"
                data-testid="fe4-number-prefix"
              />
            </label>
            <label className={styles.numPrefix}>
              <span className={styles.numPrefixLabel}>桁数</span>
              <input
                type="number"
                className={styles.numPadInput}
                value={numberPadWidth}
                onChange={(e) => setNumberPadWidth(Number(e.target.value))}
                min={0}
                max={MAX_PAD_WIDTH}
                step={1}
                aria-label="タスク番号の桁数（ゼロ埋め）"
                data-testid="fe4-number-pad"
              />
            </label>
          </>
        )}
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
          onParentResize={caps.canWrite ? onParentResize : undefined}
          onReorder={caps.canWrite ? onReorder : undefined}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
          onSelect={setSelected}
          onCreateOnDate={caps.canWrite ? onCreateOnDate : undefined}
          statusById={statusById}
          assigneeNameById={assigneeNameById}
          teamColorById={teamColorById}
          teamLegend={teamLegend}
          numberById={numberById}
          {...(rowGroupById ? { rowGroupById } : {})}
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
          barStartsAt={selectedRow?.startsAt ?? null}
          barEndsAt={selectedRow?.endsAt ?? null}
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
