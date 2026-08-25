// Per-user persistence of the chosen gantt 並び替え mode. It is a personal VIEW
// preference (like a client-side sort toggle), so it lives in localStorage keyed by
// event — no server round-trip, no contract change, $0. The manual drag order itself
// still persists server-side in the gantt view state (orderedTaskIds); this only
// remembers WHICH mode (手動 / 重要度 / 時期 / チーム) the user last picked.
import { useCallback, useState } from "react";
import type { common } from "@dub/types";
import type { GanttSortMode } from "./row-sort";

const SORT_MODES: readonly GanttSortMode[] = ["manual", "priority", "schedule", "team"];

/** User-facing labels for the sort selector (order = display order). */
export const GANTT_SORT_LABEL: Record<GanttSortMode, string> = {
  manual: "手動（ドラッグ）",
  priority: "重要度順",
  schedule: "時期が早い順",
  team: "チーム順",
};

/** Selector options in display order — the single source the UI maps over. */
export const GANTT_SORT_OPTIONS: readonly { value: GanttSortMode; label: string }[] =
  SORT_MODES.map((m) => ({ value: m, label: GANTT_SORT_LABEL[m] }));

function isSortMode(v: string | null | undefined): v is GanttSortMode {
  return !!v && (SORT_MODES as readonly string[]).includes(v);
}

function storageKey(eventId: common.EventId): string {
  return `fe4:gantt-sort:${eventId}`;
}

/** Read the saved mode (defaults to "manual"); tolerant of no/blocked storage. */
export function loadSortMode(eventId: common.EventId): GanttSortMode {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(eventId));
    return isSortMode(raw) ? raw : "manual";
  } catch {
    return "manual";
  }
}

/** Persist the mode; silently no-ops when storage is unavailable. */
export function saveSortMode(eventId: common.EventId, mode: GanttSortMode): void {
  try {
    globalThis.localStorage?.setItem(storageKey(eventId), mode);
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/** Sort-mode state backed by localStorage. Optimistic: the setter updates state
 *  immediately (the list re-sequences the same tick) and writes through to storage. */
export function useGanttSortMode(
  eventId: common.EventId,
): [GanttSortMode, (mode: GanttSortMode) => void] {
  const [mode, setMode] = useState<GanttSortMode>(() => loadSortMode(eventId));
  const set = useCallback(
    (next: GanttSortMode) => {
      setMode(next);
      saveSortMode(eventId, next);
    },
    [eventId],
  );
  return [mode, set];
}
