import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { gantt, common } from "@dub/types";
import { useApiClient } from "./client-context";
import { getGanttView, putGanttView } from "./endpoints";

/** queryKey rooted at the FeatureModule id ("tasks") per FE2 rule. */
export function ganttViewQueryKey(eventId: common.EventId) {
  return ["tasks", "gantt-view", eventId] as const;
}

/**
 * Per-user gantt view state (zoom / collapsed / manual row order). Fetched once and
 * used to overlay a personal drag order on the shared chart rows. The manual order
 * (`orderedTaskIds`) is the only field fe4 mutates here today; it is persisted via
 * PUT /gantt/views (LWW, no version — a personal setting).
 */
export function useGanttView(eventId: common.EventId) {
  const client = useApiClient();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ganttViewQueryKey(eventId),
    queryFn: (): Promise<gantt.GanttViewState> => getGanttView(client, eventId),
    staleTime: 5 * 60_000,
  });

  const current = (): gantt.GanttViewState | undefined =>
    qc.getQueryData<gantt.GanttViewState>(ganttViewQueryKey(eventId));

  /** Optimistically set the manual order in the view-state cache and persist it via
   *  PUT /gantt/views. Returns the server state; the caller rolls the gantt ROWS back
   *  on rejection (this only owns the view-state cache). */
  const saveOrder = async (orderedTaskIds: common.TaskId[]): Promise<gantt.GanttViewState> => {
    const prev = current();
    const body: gantt.PutGanttViewRequest = {
      zoom: prev?.zoom ?? "week",
      collapsedTaskIds: prev?.collapsedTaskIds ?? [],
      orderedTaskIds,
    };
    qc.setQueryData<gantt.GanttViewState>(ganttViewQueryKey(eventId), (old) =>
      old ? { ...old, orderedTaskIds } : old,
    );
    try {
      const saved = await putGanttView(client, eventId, body);
      qc.setQueryData(ganttViewQueryKey(eventId), saved);
      return saved;
    } catch (e) {
      // revert the optimistic view-cache write so the row order snaps back at once
      // (the rows are re-derived from this state — see TaskWorkspacePage.filteredDto).
      qc.setQueryData<gantt.GanttViewState>(ganttViewQueryKey(eventId), (old) =>
        old ? { ...old, ...(prev?.orderedTaskIds ? { orderedTaskIds: prev.orderedTaskIds } : { orderedTaskIds: [] }) } : old,
      );
      throw e;
    }
  };

  return { ...query, current, saveOrder };
}
