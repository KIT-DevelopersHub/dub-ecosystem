// Per-user persistence of the gantt 並び替え preference. It is a personal VIEW
// preference (a client-side sort), so it lives in localStorage keyed by event — no
// server round-trip, no contract change, $0. The manual drag order itself still
// persists server-side in the gantt view state (orderedTaskIds); this only remembers
// HOW the user wants the list ordered:
//   - 手動（ドラッグ）              : manual = true (the drag overlay is applied)
//   - 多段ソート（複数キー・優先度順）: manual = false + an ordered list of keys, each
//     with its own asc/desc direction. keys[0] is primary, keys[1] breaks its ties, …
//
// A single-key list ({keys:[{key,dir:"asc"}]}) reproduces the old single-dropdown
// behaviour, so this is a superset — the legacy stored value migrates forward.
import { useCallback, useState } from "react";
import type { common } from "@dub/types";
import type { GanttSortMode, SortDirection, SortKey, SortSpec } from "./row-sort";

// ---- labels (the single source the UI maps over) --------------------------------

const SORT_KEYS: readonly SortKey[] = ["team", "priority", "schedule"];

/** User-facing labels for each composable sort key (display order). */
export const SORT_KEY_LABEL: Record<SortKey, string> = {
  priority: "重要度順",
  schedule: "時期が早い順",
  team: "チーム順",
};

/** Key options in display order — the source the "条件を追加"/key selector maps over. */
export const SORT_KEY_OPTIONS: readonly { value: SortKey; label: string }[] = SORT_KEYS.map(
  (k) => ({ value: k, label: SORT_KEY_LABEL[k] }),
);

/** Direction labels. 昇順 = the key's natural order (重要度: urgent→low, 時期: 早→遅,
 *  チーム: チーム順の先頭→末尾). 降順 reverses it. */
export const SORT_DIRECTION_LABEL: Record<SortDirection, string> = {
  asc: "昇順",
  desc: "降順",
};

export const SORT_DIRECTION_OPTIONS: readonly { value: SortDirection; label: string }[] = [
  { value: "asc", label: SORT_DIRECTION_LABEL.asc },
  { value: "desc", label: SORT_DIRECTION_LABEL.desc },
];

// Legacy single-mode labels/options kept for any old call site (superseded by the
// multi-key control). Safe to remove once nothing imports them.
export const GANTT_SORT_LABEL: Record<GanttSortMode, string> = {
  manual: "手動（ドラッグ）",
  priority: "重要度順",
  schedule: "時期が早い順",
  team: "チーム順",
};
export const GANTT_SORT_OPTIONS: readonly { value: GanttSortMode; label: string }[] = (
  ["manual", "priority", "schedule", "team"] as const
).map((m) => ({ value: m, label: GANTT_SORT_LABEL[m] }));

// ---- state model + pure reducers -------------------------------------------------

/** The persisted preference. `manual` wins when true (drag overlay); otherwise `keys`
 *  drives a multi-key sort (empty ⇒ server/WBS default order). */
export interface GanttSortState {
  manual: boolean;
  keys: SortSpec[];
}

/** The default: manual drag (matches the pre-multi-key default of "manual"). */
export function defaultSortState(): GanttSortState {
  return { manual: true, keys: [] };
}

function isSortKey(v: unknown): v is SortKey {
  return typeof v === "string" && (SORT_KEYS as readonly string[]).includes(v);
}

/** Keys not yet present in the state — the candidates for "条件を追加" / the key
 *  selector, so the same key can't be added twice (a duplicate key is a no-op). */
export function availableKeys(state: GanttSortState): SortKey[] {
  const used = new Set(state.keys.map((s) => s.key));
  return SORT_KEYS.filter((k) => !used.has(k));
}

/** Append a condition (ascending) and leave manual mode. With an explicit `key`,
 *  adding a key already present is a no-op (keys stay unique); with no `key`, the
 *  first free key is appended. When every key is already used, only the mode flips. */
export function addSortKey(state: GanttSortState, key?: SortKey): GanttSortState {
  const used = new Set(state.keys.map((s) => s.key));
  if (key) {
    if (used.has(key)) return state.manual ? { ...state, manual: false } : state;
    return { manual: false, keys: [...state.keys, { key, dir: "asc" }] };
  }
  const next = availableKeys(state)[0];
  if (!next) return { ...state, manual: false }; // all keys used — just ensure auto mode
  return { manual: false, keys: [...state.keys, { key: next, dir: "asc" }] };
}

/** Remove the condition at `index`. Removing the last one returns to manual mode
 *  (there's nothing left to sort by, so the drag order is the sensible fallback). */
export function removeSortKey(state: GanttSortState, index: number): GanttSortState {
  const keys = state.keys.filter((_, i) => i !== index);
  return keys.length === 0 ? { manual: true, keys: [] } : { manual: false, keys };
}

/** Move the condition at `index` up (dir -1) or down (dir +1) in the priority order. */
export function moveSortKey(state: GanttSortState, index: number, dir: -1 | 1): GanttSortState {
  const to = index + dir;
  if (index < 0 || index >= state.keys.length || to < 0 || to >= state.keys.length) return state;
  const keys = state.keys.slice();
  const [moved] = keys.splice(index, 1);
  if (moved) keys.splice(to, 0, moved);
  return { ...state, keys };
}

/** Change WHICH key the condition at `index` sorts by. A no-op if the target key is
 *  already used by another condition (keys stay unique). */
export function setSortKeyField(state: GanttSortState, index: number, key: SortKey): GanttSortState {
  if (index < 0 || index >= state.keys.length) return state;
  if (state.keys[index]!.key === key) return state;
  if (state.keys.some((s, i) => i !== index && s.key === key)) return state;
  const keys = state.keys.map((s, i) => (i === index ? { ...s, key } : s));
  return { ...state, keys };
}

/** Change the asc/desc direction of the condition at `index`. */
export function setSortKeyDir(state: GanttSortState, index: number, dir: SortDirection): GanttSortState {
  if (index < 0 || index >= state.keys.length) return state;
  const keys = state.keys.map((s, i) => (i === index ? { ...s, dir } : s));
  return { ...state, keys };
}

/** Switch to manual (drag) mode, preserving the built key list so toggling back
 *  restores it. Turning manual OFF with no keys seeds a sensible first condition. */
export function setManual(state: GanttSortState, manual: boolean): GanttSortState {
  if (manual) return { ...state, manual: true };
  if (state.keys.length > 0) return { ...state, manual: false };
  return addSortKey({ manual: false, keys: [] });
}

/** Short one-line summary of the active sort (for the trigger button). */
export function summarizeSort(state: GanttSortState): string {
  if (state.manual || state.keys.length === 0) return GANTT_SORT_LABEL.manual;
  return state.keys.map((s) => SORT_KEY_LABEL[s.key]).join(" → ");
}

// ---- persistence -----------------------------------------------------------------

function storageKey(eventId: common.EventId): string {
  return `fe4:gantt-sort:${eventId}`;
}

/** Coerce arbitrary parsed JSON / a legacy plain-string value into a valid state.
 *  Legacy values: "manual" ⇒ manual mode; "priority"/"schedule"/"team" ⇒ a single
 *  ascending key. Anything unrecognized falls back to the default. */
function coerceState(raw: unknown): GanttSortState {
  if (typeof raw === "string") {
    // legacy single-value storage
    if (raw === "manual") return defaultSortState();
    if (isSortKey(raw)) return { manual: false, keys: [{ key: raw, dir: "asc" }] };
    return defaultSortState();
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { manual?: unknown; keys?: unknown };
    const keys: SortSpec[] = Array.isArray(obj.keys)
      ? obj.keys
          .filter(
            (k): k is { key: SortKey; dir?: unknown } =>
              !!k && typeof k === "object" && isSortKey((k as { key?: unknown }).key),
          )
          .map<SortSpec>((k) => ({ key: k.key, dir: k.dir === "desc" ? "desc" : "asc" }))
          // keys stay unique — drop a later duplicate key
          .filter((k, i, all) => all.findIndex((o) => o.key === k.key) === i)
      : [];
    const manual = obj.manual === true || keys.length === 0;
    return { manual, keys };
  }
  return defaultSortState();
}

/** Read the saved preference (defaults to manual); tolerant of no/blocked storage
 *  and of the legacy single-string format. */
export function loadGanttSort(eventId: common.EventId): GanttSortState {
  try {
    const rawStr = globalThis.localStorage?.getItem(storageKey(eventId));
    if (rawStr == null) return defaultSortState();
    let parsed: unknown = rawStr;
    try {
      parsed = JSON.parse(rawStr);
    } catch {
      parsed = rawStr; // legacy plain string (e.g. "priority")
    }
    return coerceState(parsed);
  } catch {
    return defaultSortState();
  }
}

/** Persist the preference; silently no-ops when storage is unavailable. */
export function saveGanttSort(eventId: common.EventId, state: GanttSortState): void {
  try {
    globalThis.localStorage?.setItem(storageKey(eventId), JSON.stringify(state));
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/** Actions the control invokes; each maps to a pure reducer + write-through. */
export interface GanttSortActions {
  setManual: (manual: boolean) => void;
  addKey: (key?: SortKey) => void;
  removeKey: (index: number) => void;
  moveKey: (index: number, dir: -1 | 1) => void;
  setKey: (index: number, key: SortKey) => void;
  setDir: (index: number, dir: SortDirection) => void;
}

/** Sort-preference state backed by localStorage. Optimistic: each action updates
 *  state immediately (the list re-sequences the same tick) and writes through. */
export function useGanttSort(eventId: common.EventId): [GanttSortState, GanttSortActions] {
  const [state, setState] = useState<GanttSortState>(() => loadGanttSort(eventId));
  const apply = useCallback(
    (fn: (s: GanttSortState) => GanttSortState) => {
      setState((prev) => {
        const next = fn(prev);
        saveGanttSort(eventId, next);
        return next;
      });
    },
    [eventId],
  );
  const actions = useCallback<() => GanttSortActions>(
    () => ({
      setManual: (manual) => apply((s) => setManual(s, manual)),
      addKey: (key) => apply((s) => addSortKey(s, key)),
      removeKey: (index) => apply((s) => removeSortKey(s, index)),
      moveKey: (index, dir) => apply((s) => moveSortKey(s, index, dir)),
      setKey: (index, key) => apply((s) => setSortKeyField(s, index, key)),
      setDir: (index, dir) => apply((s) => setSortKeyDir(s, index, dir)),
    }),
    [apply],
  )();
  return [state, actions];
}
