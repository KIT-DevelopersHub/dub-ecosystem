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
  return { ...query, refetchFresh, setRowScheduleOptimistic };
}
