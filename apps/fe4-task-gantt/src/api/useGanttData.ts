import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { gantt, common } from "@dub/types";
import { useApiClient } from "./client-context";
import { getGantt, getGanttFresh } from "./endpoints";

/** queryKey rooted at the FeatureModule id ("tasks") per FE2 rule. */
export function ganttQueryKey(eventId: common.EventId) {
  return ["tasks", "gantt", eventId] as const;
}

/** Recompute every row's `hasChildren` from the current parent links, so a parent
 *  gains its toggle the instant it takes its first child (optimistic subtask add)
 *  and loses it the instant its last child leaves (re-parent / optimistic delete).
 *  The gantt read model derives this flag server-side; we mirror it here so the
 *  optimistic cache matches what the next GET will return. */
function withRecomputedHasChildren(rows: readonly gantt.GanttRow[]): gantt.GanttRow[] {
  const withKids = new Set(rows.map((r) => r.parentTaskId).filter((p): p is common.TaskId => !!p));
  return rows.map((r) => (r.hasChildren === withKids.has(r.taskId) ? r : { ...r, hasChildren: withKids.has(r.taskId) }));
}

export function useGanttData(eventId: common.EventId) {
  const client = useApiClient();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ganttQueryKey(eventId),
    queryFn: (): Promise<gantt.GanttChartDTO> => getGantt(client, eventId),
  });
  /** Read the LIVE cached rows at call time (not a render-snapshot). Deferred
   *  commands (undo/redo run long after they were pushed) must compute against
   *  the current bar positions, else a relative shift is applied to a stale base
   *  and overshoots — see the parent drag-shift undo bug. */
  const currentRows = (): gantt.GanttChartDTO["rows"] =>
    qc.getQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId))?.rows ?? [];
  /** LIVE cached dependency lines (same rationale as currentRows). Used to snapshot
   *  the before-state for an optimistic dependency edit so a failure can snap back
   *  instantly instead of waiting on the reconciling refetch. */
  const currentDependencies = (): gantt.GanttChartDTO["dependencies"] =>
    qc.getQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId))?.dependencies ?? [];
  /** after an edit, refetch with Cache-Control: no-cache (design test 6). */
  const refetchFresh = async () => {
    const fresh = await getGanttFresh(client, eventId);
    qc.setQueryData(ganttQueryKey(eventId), fresh);
    return fresh;
  };
  /** Optimistically move/resize a bar in the cache so the timeline updates the
   *  same tick as the drag drop (before the persist round-trip resolves). */
  const setRowScheduleOptimistic = (
    taskId: common.TaskId,
    startsAt: common.ISODateTime | null,
    endsAt: common.ISODateTime | null,
  ) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) =>
      old
        ? { ...old, rows: old.rows.map((r) => (r.taskId === taskId ? { ...r, startsAt, endsAt } : r)) }
        : old,
    );
  };
  /** Optimistically insert/replace a bar (used for optimistic create so a new task
   *  appears on the timeline the same tick, before the POST resolves). */
  const upsertRowOptimistic = (row: gantt.GanttRow) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) =>
      old
        ? // recompute hasChildren so a childless parent gains its toggle the moment
          // a subtask is inserted under it (else the new child stays hidden with no toggle)
          { ...old, rows: withRecomputedHasChildren([...old.rows.filter((r) => r.taskId !== row.taskId), row]) }
        : old,
    );
  };
  /** Optimistically insert/replace a bar AND its connector lines the same tick — used
   *  by optimistic create so a new task with 依存(先行タスク) draws its bar and its
   *  dependency arrows before the POST + deps persist resolve. Rows go through the same
   *  hasChildren recompute as {@link upsertRowOptimistic}; each dep line is appended (or
   *  replaced by id, so a re-paint is idempotent). */
  const addRowOptimistic = (row: gantt.GanttRow, deps: readonly gantt.GanttDependencyLine[] = []) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) => {
      if (!old) return old;
      const rows = withRecomputedHasChildren([...old.rows.filter((r) => r.taskId !== row.taskId), row]);
      const newIds = new Set(deps.map((d) => d.id));
      const dependencies = [...old.dependencies.filter((d) => !newIds.has(d.id)), ...deps];
      return { ...old, rows, dependencies };
    });
  };
  /** Optimistically drop a bar AND every connector line touching it (optimistic delete,
   *  or rolling back a provisional bar) so a stale arrow never lingers past the row. */
  const removeRowOptimistic = (taskId: common.TaskId) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) =>
      old
        ? {
            ...old,
            // recompute hasChildren so a parent that just lost its last child drops its toggle
            rows: withRecomputedHasChildren(old.rows.filter((r) => r.taskId !== taskId)),
            dependencies: old.dependencies.filter((d) => d.fromTaskId !== taskId && d.toTaskId !== taskId),
          }
        : old,
    );
  };
  /** Optimistically re-parent (or detach with null) a row so the tree reflects the
   *  change the same tick — the child leaves/joins a work-package immediately instead
   *  of appearing stuck inside the old parent's toggle until the refetch lands. Depth
   *  follows the new parent (null ⇒ top-level, depth 0); the old/new parents'
   *  `hasChildren` is recomputed so an emptied parent loses its toggle at once. */
  const setRowParentOptimistic = (taskId: common.TaskId, parentTaskId: common.TaskId | null) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) => {
      if (!old) return old;
      const parentDepth = parentTaskId ? old.rows.find((r) => r.taskId === parentTaskId)?.depth ?? 0 : -1;
      const rows = old.rows.map((r) =>
        r.taskId === taskId ? { ...r, parentTaskId, depth: parentDepth + 1 } : r,
      );
      // recompute hasChildren from the mutated parent links (an emptied parent drops its
      // toggle; the new parent gains one)
      return { ...old, rows: withRecomputedHasChildren(rows) };
    });
  };
  /** Optimistically set the predecessor (先行タスク＝依存) edges of ONE task so the
   *  timeline's arrows appear/disappear the SAME tick the user saves — instead of
   *  waiting for the persist + refetch round-trip (the "追加/削除しても時差があって
   *  失敗したか不安" complaint). Edges point predecessor(from) → task(to); this
   *  rebuilds exactly the `to === taskId` edges from `dependsOnIds` and leaves every
   *  other task's edges untouched. Server dedup/format is mirrored (`${to}->${from}`). */
  const setDependenciesOptimistic = (taskId: common.TaskId, dependsOnIds: readonly common.TaskId[]) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) => {
      if (!old) return old;
      const others = old.dependencies.filter((d) => d.toTaskId !== taskId);
      const seen = new Set(others.map((d) => d.id));
      const next = [...others];
      for (const from of dependsOnIds) {
        if (from === taskId) continue; // no self-edge
        const id = `${taskId}->${from}`;
        if (seen.has(id)) continue;
        seen.add(id);
        next.push({ id, fromTaskId: from, toTaskId: taskId, type: "FS", lagDays: 0 });
      }
      return { ...old, dependencies: next };
    });
  };
  return {
    ...query,
    currentRows,
    currentDependencies,
    refetchFresh,
    setRowScheduleOptimistic,
    upsertRowOptimistic,
    addRowOptimistic,
    removeRowOptimistic,
    setRowParentOptimistic,
    setDependenciesOptimistic,
  };
}
