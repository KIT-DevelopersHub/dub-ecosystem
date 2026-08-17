import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { gantt, common } from "@dub/types";
import { useApiClient } from "./client-context";
import { getGantt, getGanttFresh } from "./endpoints";

/** queryKey rooted at the FeatureModule id ("tasks") per FE2 rule. */
export function ganttQueryKey(eventId: common.EventId) {
  return ["tasks", "gantt", eventId] as const;
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
        ? { ...old, rows: [...old.rows.filter((r) => r.taskId !== row.taskId), row] }
        : old,
    );
  };
  /** Optimistically drop a bar (optimistic delete, or discarding a provisional bar). */
  const removeRowOptimistic = (taskId: common.TaskId) => {
    qc.setQueryData<gantt.GanttChartDTO>(ganttQueryKey(eventId), (old) =>
      old ? { ...old, rows: old.rows.filter((r) => r.taskId !== taskId) } : old,
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
      // recompute hasChildren from the mutated parent links (an emptied parent drops its toggle)
      const withKids = new Set(rows.map((r) => r.parentTaskId).filter((p): p is common.TaskId => !!p));
      return { ...old, rows: rows.map((r) => ({ ...r, hasChildren: withKids.has(r.taskId) })) };
    });
  };
  return {
    ...query,
    currentRows,
    refetchFresh,
    setRowScheduleOptimistic,
    upsertRowOptimistic,
    removeRowOptimistic,
    setRowParentOptimistic,
  };
}
